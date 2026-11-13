import { z } from "zod";
import { registryGet, registrySearch, type RegistryEntry } from "../adapters/bibliocommons/registry.js";
import { TTL } from "../core/cache.js";
import { resolveLibrary, type Context } from "../core/context.js";
import { StacksError } from "../core/errors.js";
import { startJob } from "../core/jobs.js";
import { hostOf, matchLabel, norm } from "../core/text.js";
import { defineTool, libraryArg, sourceField } from "../core/tool.js";
import {
  AvailabilitySummarySchema,
  BranchAvailabilitySchema,
  FormatSchema,
  LibrarySchema,
  TitleDetailsSchema,
  TitleSchema,
  type Library,
} from "../schemas.js";

const titleIdArg = z.string().describe('A title_id from search_catalog, e.g. "S234C3970025".');

/** If the fast path broke because the site changed, queue a slower Agent run so the caller can still get an answer. */
async function withAgentFallback<T>(ctx: Context, kind: "search" | "availability", library: string, arg: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof StacksError && err.code === "SITE_CHANGED") {
      try {
        err.details.fallback_job_id = await startJob(ctx.web, kind, ctx.adapter.agentFallback(kind, library, arg));
        err.details.fallback = "A slower TinyFish Agent run was started to read the page instead. Poll get_job_result with fallback_job_id. Its result is best-effort and not schema-validated.";
      } catch (startErr) {
        // The fallback is a courtesy and SITE_CHANGED stays the signal, but say that it could not start.
        err.details.fallback = `A TinyFish Agent fallback could not be started: ${(startErr as Error).message}`;
      }
    }
    throw err;
  }
}

export const findLibrary = defineTool({
  name: "find_library",
  title: "Find a library",
  description:
    "Find the public library system for a city or library name and get its library_id. Call this first: every other tool needs the library_id. Covers library systems whose catalogue runs on BiblioCommons (e.g. Toronto, Vancouver, Chicago, Seattle, San Francisco, Boston, Ottawa, Calgary).",
  input: {
    query: z.string().min(2).describe('A city, region or library name, e.g. "Toronto", "Seattle Public Library", "King County".'),
  },
  output: {
    matches: z.array(LibrarySchema).describe("Best match first. Empty if no supported library was found."),
    note: z.string().nullable(),
    ...sourceField,
  },
  handler: async ({ query }, ctx) => {
    const verify = async (ids: string[]): Promise<Map<string, string>> => {
      const pages = await ctx.web.fetch(ids.map((id) => `${ctx.adapter.catalogUrl(id)}/v2/search?query=library&searchType=smart`));
      const names = new Map<string, string>();
      for (const p of pages) {
        const host = new URL(p.final_url ?? p.url).host;
        const name = p.title?.match(/^Search\s+[—–-]\s+(.+?)\s*$/)?.[1];
        if (name && host.endsWith(".bibliocommons.com")) names.set(host.split(".")[0]!, name);
      }
      return names;
    };
    const toLibrary = (e: RegistryEntry, verified: boolean): Library => ({
      library_id: e.id,
      name: e.name,
      catalog_url: ctx.adapter.catalogUrl(e.id),
      city: e.city,
      region: e.region,
      country: e.country,
      verified,
    });

    const { value, cached } = await ctx.cache.wrap(`find:${query.toLowerCase()}`, TTL.library, async () => {
      const known = registrySearch(query).slice(0, 5);
      if (known.length) {
        const live = await verify(known.map((k) => k.id));
        return {
          engines: ["fetch"] as const,
          matches: known.map((k) => toLibrary(k, live.has(k.id))),
          note: null as string | null,
          retrieved_at: new Date().toISOString(),
        };
      }
      // Not in the directory: look for it on the open web, then confirm it is a live catalogue.
      const hits = await ctx.web.search(`${query} public library bibliocommons catalogue`);
      const ids = [
        ...new Set(
          hits
            .map((h) => hostOf(h.url)?.match(/^([a-z0-9-]+)\.bibliocommons\.com$/)?.[1])
            .filter((id): id is string => !!id && !["www", "gateway", "help", "partnerportal"].includes(id)),
        ),
      ].slice(0, 4);
      const live = ids.length ? await verify(ids) : new Map<string, string>();
      // Web search returns loosely related catalogues. Keep only libraries whose own name
      // contains a word from the query, so "Brooklyn" never resolves to some other city.
      const wanted = norm(query).split(" ").filter((w) => w.length > 2 && !["public", "library", "libraries", "county", "city", "the"].includes(w));
      const matches = [...live.entries()]
        .filter(([, name]) => wanted.some((w) => norm(name).split(" ").includes(w)))
        .map(([id, name]) => toLibrary(registryGet(id) ?? { id, name, city: null, region: null, country: null }, true));
      return {
        engines: ["search", "fetch"] as const,
        matches,
        note: matches.length
          ? "Found by web search and confirmed live. Check the name matches the library you meant."
          : `No BiblioCommons catalogue found for "${query}". This library may use a different platform, which Stacks does not support yet.`,
        retrieved_at: new Date().toISOString(),
      };
    });
    return {
      matches: value.matches,
      note: value.note,
      source: { engines: [...value.engines], url: null, cached, retrieved_at: value.retrieved_at },
    };
  },
});

export const searchCatalog = defineTool({
  name: "search_catalog",
  title: "Search the catalogue",
  description:
    "Search a library's catalogue for books, eBooks, audiobooks, DVDs and more. Returns typed titles with live availability counts and hold queues. Use the title_id of a result with check_availability to see which branches have a copy on the shelf.",
  input: {
    library: libraryArg,
    query: z.string().min(1).max(200).describe("What to search for: a title, author, subject or keywords. At most 200 characters."),
    search_type: z.enum(["keyword", "title", "author", "subject", "series"]).default("keyword"),
    format: z
      .string()
      .optional()
      .describe("Only this format: book, ebook, audiobook, eaudiobook, large_print, graphic_novel, picture_book, dvd, bluray, music_cd, magazine (or a platform format code such as BK)."),
    available_at_branch: z.string().optional().describe("Only titles with a copy available right now at this branch (name or code from list_branches)."),
    page: z.number().int().min(1).max(50).default(1).describe("Results page. A page holds 20 titles at most libraries and 10 at some; `pages` gives the count."),
  },
  output: {
    library: z.string(),
    query: z.string(),
    total: z.number().int().describe("Total matching titles across all pages."),
    page: z.number().int(),
    pages: z.number().int(),
    did_you_mean: z.string().nullable().describe("The site's spelling suggestion, if it had one."),
    results: z.array(TitleSchema),
    ...sourceField,
  },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    const { data, source } = await withAgentFallback(ctx, "search", library, args.query, () =>
      ctx.adapter.search(library, { query: args.query, search_type: args.search_type, format: args.format, available_at_branch: args.available_at_branch, page: args.page }),
    );
    return { library, query: args.query, total: data.total, page: data.page, pages: data.pages, did_you_mean: data.did_you_mean, results: data.titles, source };
  },
});

export const getTitle = defineTool({
  name: "get_title",
  title: "Get title details",
  description: "Full details for one title: description, contributors, publisher, ISBNs, subjects, series, and every other format the library holds it in.",
  input: { library: libraryArg, title_id: titleIdArg },
  output: { library: z.string(), title: TitleDetailsSchema, ...sourceField },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    const { data, source } = await ctx.adapter.getTitle(library, args.title_id);
    return { library, title: data.details, source };
  },
});

export const checkAvailability = defineTool({
  name: "check_availability",
  title: "Check availability by branch",
  description:
    "Live, copy-level availability for one title: which branches have it on the shelf right now, call numbers, and due dates for checked-out copies. Branches with a copy on the shelf are listed first.",
  input: {
    library: libraryArg,
    title_id: titleIdArg,
    branch: z.string().optional().describe("Only this branch (name or code)."),
    on_shelf_only: z.boolean().default(false).describe("Only branches where a copy is on the shelf right now."),
    limit: z.number().int().min(1).max(150).default(15).describe("Maximum number of branches to return."),
  },
  output: {
    library: z.string(),
    title_id: z.string(),
    title: z.string(),
    format: FormatSchema,
    summary: AvailabilitySummarySchema,
    branches_holding: z.number().int().describe("Branches that own at least one copy."),
    branches_on_shelf: z.number().int().describe("Branches with a copy on the shelf right now."),
    branches: z.array(BranchAvailabilitySchema),
    truncated: z.boolean().describe("True if more branches matched than `limit`."),
    ...sourceField,
  },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    const { data, source } = await withAgentFallback(ctx, "availability", library, args.title_id, () => ctx.adapter.getTitle(library, args.title_id));
    let branches = data.branches;
    if (args.branch) {
      const hit = branches.find((b) => b.branch_code.toLowerCase() === args.branch!.toLowerCase()) ?? matchLabel(args.branch, branches, (b) => [b.branch_name]);
      if (!hit) {
        // A real branch that owns no copy is an answer. A name that is no branch at all is a mistake.
        const all = await ctx.adapter
          .listBranches(library)
          .then((r) => r.data)
          .catch((err: unknown) => {
            if (err instanceof StacksError && err.code === "NOT_SUPPORTED") return null;
            throw err;
          });
        const real = all && (all.find((b) => b.branch_code.toLowerCase() === args.branch!.toLowerCase()) ?? matchLabel(args.branch, all, (b) => [b.name]));
        if (all && !real) {
          throw new StacksError("NOT_FOUND", `No branch matching "${args.branch}" at this library.`, {
            hint: "Call list_branches to see valid branch names and codes.",
            details: { examples: all.slice(0, 8).map((b) => `${b.name} (${b.branch_code})`) },
          });
        }
      }
      branches = hit ? [hit] : [];
    }
    if (args.on_shelf_only) branches = branches.filter((b) => b.copies_on_shelf > 0);
    return {
      library,
      title_id: data.details.title_id, // the library's own id, if the site redirected the one asked for
      title: data.details.title,
      format: data.details.format,
      summary: data.summary,
      branches_holding: data.branches.length,
      branches_on_shelf: data.branches.filter((b) => b.copies_on_shelf > 0).length,
      branches: branches.slice(0, args.limit),
      truncated: branches.length > args.limit,
      source,
    };
  },
});

const DAY_MS = 86_400_000;

export const estimateWait = defineTool({
  name: "estimate_wait",
  title: "Estimate the wait for a title",
  description:
    "Estimate how long you would wait if you placed a hold today, from the live hold queue, copy count and due dates. Also lists other formats of the same work with a shorter queue. This is an estimate computed by Stacks, not a figure published by the library.",
  input: {
    library: libraryArg,
    title_id: titleIdArg,
    loan_days: z.number().int().min(1).max(60).default(21).describe("The library's loan period in days. 21 is typical for books."),
  },
  output: {
    library: z.string(),
    title_id: z.string(),
    title: z.string(),
    format: FormatSchema,
    available_now: z.boolean().describe("True if a copy is on a shelf somewhere right now."),
    on_shelf_at: z.array(z.string()).describe("Up to 8 branches with a copy on the shelf."),
    holds: z.number().int().nullable(),
    circulating_copies: z.number().int(),
    estimated_wait_days: z.object({ low: z.number().int(), likely: z.number().int(), high: z.number().int() }).nullable().describe("Null when no estimate is possible (e.g. no circulating copies)."),
    basis: z.string().describe("How the estimate was computed."),
    faster_alternatives: z.array(
      z.object({ title_id: z.string(), format: FormatSchema, holds: z.number().int().nullable(), total_copies: z.number().int().nullable(), available_copies: z.number().int().nullable(), why: z.string() }),
    ),
    ...sourceField,
  },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    const { data, source } = await ctx.adapter.getTitle(library, args.title_id);
    const copies = data.branches.flatMap((b) => b.copies);
    const circulating = copies.filter((c) => c.status !== "library_use_only" && c.status !== "on_order");
    const onShelfAt = data.branches.filter((b) => b.copies_on_shelf > 0).map((b) => b.branch_name);
    const holds = data.summary.holds;
    const cycle = args.loan_days + 3; // loan period plus transit and pickup

    let estimate: { low: number; likely: number; high: number } | null = null;
    let basis: string;
    if (onShelfAt.length) {
      estimate = { low: 0, likely: 0, high: 0 };
      basis = `A copy is on the shelf at ${onShelfAt.length} branch${onShelfAt.length === 1 ? "" : "es"}, so you can borrow it today in person.`;
    } else if (!circulating.length) {
      basis = copies.length ? "The library's copies are for in-library use only or still on order, so no wait can be estimated." : "The library lists no physical copies for this title (it may be digital). No wait can be estimated.";
    } else {
      const today = Date.now();
      const returns = circulating
        .map((c) => (c.due_date ? Math.max(0, Math.ceil((Date.parse(c.due_date) - today) / DAY_MS)) + 3 : 3))
        .sort((a, b) => a - b);
      const position = (holds ?? 0) + 1;
      const index = (position - 1) % returns.length;
      const rounds = Math.floor((position - 1) / returns.length);
      const likely = (returns[index] ?? cycle) + rounds * cycle;
      estimate = { low: Math.max(1, Math.round(likely * 0.6)), likely, high: Math.round(likely * 1.4) + 3 };
      basis = `You would be number ${position} in the queue for ${circulating.length} circulating cop${circulating.length === 1 ? "y" : "ies"}. Copies are assumed to come back on their due dates and to be re-lent for ${args.loan_days} days plus 3 days of transit. Early returns shorten the wait; renewals lengthen it.`;
    }

    const selfRatio = holds !== null && circulating.length ? holds / circulating.length : Infinity;
    const faster = data.details.other_formats
      .filter((o) => {
        const a = o.availability;
        if (a.status === "unknown" || a.status === "unavailable") return false;
        if (onShelfAt.length) return false;
        if ((a.available_copies ?? 0) > 0) return true;
        return a.holds !== null && (a.total_copies ?? 0) > 0 && a.holds / (a.total_copies as number) < selfRatio;
      })
      .map((o) => ({
        title_id: o.title_id,
        format: o.format,
        holds: o.availability.holds,
        total_copies: o.availability.total_copies,
        available_copies: o.availability.available_copies,
        why: (o.availability.available_copies ?? 0) > 0 ? "Available now" : `Shorter queue: ${o.availability.holds} holds on ${o.availability.total_copies} copies`,
      }))
      .slice(0, 5);

    return {
      library,
      title_id: data.details.title_id, // the library's own id, if the site redirected the one asked for
      title: data.details.title,
      format: data.details.format,
      available_now: onShelfAt.length > 0,
      on_shelf_at: onShelfAt.slice(0, 8),
      holds,
      circulating_copies: circulating.length,
      estimated_wait_days: estimate,
      basis,
      faster_alternatives: faster,
      source,
    };
  },
});
