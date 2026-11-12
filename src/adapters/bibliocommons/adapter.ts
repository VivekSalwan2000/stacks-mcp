/**
 * BiblioCommons adapter.
 *
 * BiblioCommons powers the catalogue, events and locations pages of 200+
 * public library systems at https://<library>.bibliocommons.com. It has no
 * public API. Every page server-renders its data into a JSON <script> tag;
 * Stacks loads the page in a TinyFish remote browser and reads that data
 * (plus, on title pages, the page's own background availability request).
 */
import { z } from "zod";
import { TTL, type TtlCache } from "../../core/cache.js";
import { contract, StacksError } from "../../core/errors.js";
import { agentSchema } from "../../core/jobs.js";
import { matchLabel } from "../../core/text.js";
import type { PageRead, Web } from "../../core/web.js";
import type { Branch, Source } from "../../schemas.js";
import type {
  EventParams,
  EventResult,
  Landmark,
  LibraryAdapter,
  LibraryInfo,
  SearchParams,
  SearchResult,
  Sourced,
  TitleRecord,
} from "../types.js";
import { RawAvailabilityResponse, RawEventsState, RawLocationsState, RawRecordState, RawSearchState } from "./contracts.js";
import { FORMAT_ALIASES, libraryInfo, parseAvailability, parseBranches, parseEvents, parseRecord, parseSearch } from "./parse.js";

const STATE_SELECTOR = 'script[type="application/json"][data-iso-key="_0"]';
const SEARCH_TYPES: Record<SearchParams["search_type"], string> = { keyword: "smart", title: "title", author: "author", subject: "subject", series: "series" };

type PageKind = "search" | "title" | "branches" | "events";

interface Stamped<T> {
  data: T;
  url: string;
  retrieved_at: string;
}

export class BiblioCommonsAdapter implements LibraryAdapter {
  readonly platform = "bibliocommons";

  constructor(
    private web: Web,
    private cache: TtlCache,
  ) {}

  validId(id: string) {
    return /^[a-z0-9][a-z0-9-]{1,39}$/.test(id);
  }

  catalogUrl(id: string) {
    return `https://${id}.bibliocommons.com`;
  }

  recordUrl(id: string, titleId: string) {
    return `${this.catalogUrl(id)}/v2/record/${titleId}`;
  }

  /** Load a page and return its embedded data, or explain exactly why it could not be read. */
  private async read(id: string, url: string, kind: PageKind, opts: { capture?: Record<string, RegExp>; shouldCapture?: (s: unknown) => boolean } = {}): Promise<PageRead> {
    if (!this.validId(id)) {
      throw new StacksError("UNKNOWN_LIBRARY", `"${id}" is not a valid library id.`, { hint: "Call find_library to get the library_id for a city or library name." });
    }
    let read = await this.web.readPage(url, { stateSelector: STATE_SELECTOR, ...opts });
    if (read.state !== null) return read;

    let host = new URL(read.finalUrl || url).host;
    if (read.status >= 200 && read.status < 400 && host === `${id}.bibliocommons.com`) {
      // The page loaded without its data. This is occasionally a one-off (a partial
      // response), so read it once more before declaring that the site changed.
      read = await this.web.readPage(url, { stateSelector: STATE_SELECTOR, ...opts });
      if (read.state !== null) return read;
      host = new URL(read.finalUrl || url).host;
    }
    const details = { url, http_status: read.status };
    if (read.status === 404 || host !== `${id}.bibliocommons.com`) {
      throw new StacksError("UNKNOWN_LIBRARY", `No BiblioCommons library with id "${id}".`, { hint: "Call find_library to get the right library_id.", details });
    }
    if (read.status === 403 || read.status === 429) {
      throw new StacksError("SITE_BLOCKED", `${host} refused the request (HTTP ${read.status}).`, {
        hint:
          read.via === "proxy"
            ? "This library's bot protection blocks automated browsers, including through a proxy. Stacks cannot read it right now."
            : "This library blocks some regions or automated browsers. Set STACKS_PROXY=auto or to the library's country code (e.g. US) and retry.",
        details,
      });
    }
    if (read.status >= 500) {
      if (kind === "branches" || kind === "events") {
        throw new StacksError("NOT_SUPPORTED", `${host} does not serve a ${kind} page (HTTP ${read.status}). This library may not use BiblioCommons for ${kind}.`, { details });
      }
      throw new StacksError("SITE_UNAVAILABLE", `${host} returned HTTP ${read.status}.`, { details });
    }
    throw new StacksError("SITE_CHANGED", `The ${kind} page at ${host} loaded (HTTP ${read.status}) but no longer embeds its data where Stacks reads it.`, {
      hint: "The website changed. Run health_check for a full report and open an issue at https://github.com/VivekSalwan2000/stacks-mcp/issues.",
      details: { ...details, contract: `${kind} page state`, broken_fields: [`${STATE_SELECTOR}: not found`] },
    });
  }

  private async cached<T>(key: string, ttl: number, compute: () => Promise<Stamped<T>>): Promise<Sourced<T>> {
    const { value, cached } = await this.cache.wrap(key, ttl, compute);
    const source: Source = { engines: ["browser"], url: value.url, cached, retrieved_at: value.retrieved_at };
    return { data: value.data, source };
  }

  private stamp<T>(data: T, url: string): Stamped<T> {
    return { data, url, retrieved_at: new Date().toISOString() };
  }

  async getLibrary(id: string): Promise<Sourced<LibraryInfo>> {
    return this.cached(`bc:${id}:library`, TTL.library, async () => {
      const url = `${this.catalogUrl(id)}/v2/search?query=library&searchType=smart`;
      const read = await this.read(id, url, "search");
      const state = contract(RawSearchState, read.state, { contract: "search page", url });
      return this.stamp(libraryInfo(id, state.app, state.entities.libraries), url);
    });
  }

  async search(id: string, params: SearchParams): Promise<Sourced<SearchResult>> {
    const qs = new URLSearchParams({ query: params.query, searchType: SEARCH_TYPES[params.search_type] });
    if (params.format) qs.set("f_FORMAT", FORMAT_ALIASES[params.format.toLowerCase()] ?? params.format.toUpperCase());
    if (params.available_at_branch) qs.set("f_STATUS", await this.branchCode(id, params.available_at_branch));
    if (params.page > 1) qs.set("page", String(params.page));
    const url = `${this.catalogUrl(id)}/v2/search?${qs}`;
    return this.cached(`bc:${id}:search:${qs}`, TTL.search, async () => {
      const read = await this.read(id, url, "search");
      const state = contract(RawSearchState, read.state, { contract: "search page", url });
      return this.stamp(parseSearch(state, this.catalogUrl(id)), url);
    });
  }

  async getTitle(id: string, titleId: string, followed = false): Promise<Sourced<TitleRecord>> {
    if (!/^S\d+C\d+$/.test(titleId)) {
      throw new StacksError("INVALID_INPUT", `"${titleId}" is not a valid title_id.`, { hint: "title_id looks like S234C3970025. Get one from search_catalog." });
    }
    const url = this.recordUrl(id, titleId);
    return this.cached(`bc:${id}:title:${titleId}`, TTL.availability, async () => {
      // Only wait for the availability request when the page is about this very title.
      const hasRecord = (s: unknown) => titleId in ((s as { entities?: { catalogBibs?: object } })?.entities?.catalogBibs ?? {});
      const read = await this.read(id, url, "title", {
        capture: { availability: new RegExp(`/bibs/${titleId}/availability`) },
        shouldCapture: hasRecord,
      });
      const state = contract(RawRecordState, read.state, { contract: "title page", url });
      // An id from another library is redirected by the site to this library's own
      // record for the same work. Follow it once instead of misreading the page.
      const shown = Object.keys(state.entities.catalogBibs ?? {});
      if (shown.length > 0 && !shown.includes(titleId)) {
        const own = shown[0]!;
        if (!followed && /^S\d+C\d+$/.test(own)) {
          const real = await this.getTitle(id, own, true);
          return this.stamp(real.data, real.source.url ?? this.recordUrl(id, own));
        }
        throw new StacksError("NOT_FOUND", `No title with id ${titleId} at this library.`, { hint: "Get a valid title_id from search_catalog." });
      }
      const details = parseRecord(state, titleId, this.catalogUrl(id));
      if (read.captured.availability === undefined) {
        throw new StacksError("SITE_CHANGED", "The title page loaded but never requested its per-branch availability data.", {
          details: { url, contract: "availability request", broken_fields: [`GET /bibs/${titleId}/availability: not observed`] },
        });
      }
      const avail = contract(RawAvailabilityResponse, read.captured.availability, { contract: "availability response", url });
      const { summary, branches } = parseAvailability(avail, titleId);
      return this.stamp({ details: { ...details, availability: summary }, summary, branches }, url);
    });
  }

  async listBranches(id: string): Promise<Sourced<Branch[]>> {
    const url = `${this.catalogUrl(id)}/v2/locations`;
    const state = await this.cached(`bc:${id}:branches`, TTL.branches, async () => {
      const read = await this.read(id, url, "branches");
      return this.stamp(contract(RawLocationsState, read.state, { contract: "locations page", url }), url);
    });
    // Parsed on every call so open_now and today's hours are always current.
    return { data: parseBranches(state.data), source: state.source };
  }

  /** Resolve what the user typed (a code or a name) to a branch code. */
  private async branchCode(id: string, input: string): Promise<string> {
    let branches: Branch[];
    try {
      branches = (await this.listBranches(id)).data;
    } catch (err) {
      if (err instanceof StacksError && err.code === "NOT_SUPPORTED" && /^[A-Za-z0-9_-]{1,10}$/.test(input)) return input.toUpperCase();
      throw err;
    }
    const hit = branches.find((b) => b.branch_code.toLowerCase() === input.toLowerCase()) ?? matchLabel(input, branches, (b) => [b.name]);
    if (!hit) {
      throw new StacksError("INVALID_INPUT", `No branch matching "${input}" at this library.`, {
        hint: "Call list_branches to see valid branch names and codes.",
        details: { examples: branches.slice(0, 8).map((b) => `${b.name} (${b.branch_code})`) },
      });
    }
    return hit.branch_code;
  }

  private async eventsPage(id: string, qs: URLSearchParams) {
    const query = qs.toString();
    const url = `${this.catalogUrl(id)}/v2/events${query ? `?${query}` : ""}`;
    return this.cached(`bc:${id}:events:${query}`, TTL.events, async () => {
      const read = await this.read(id, url, "events");
      // A library that does not use BiblioCommons for events still serves the page, with an
      // untouched initial state: no query, no pagination, no filters. That is "not supported",
      // which is different from the page changing shape.
      const es = (read.state as { events?: { eventsSearch?: Record<string, unknown> } })?.events?.eventsSearch;
      const blank = (v: unknown) => !!v && typeof v === "object" && Object.keys(v).length === 0;
      if (es && blank(es.pagination) && blank(es.facetFields) && blank(es.query)) {
        throw new StacksError("NOT_SUPPORTED", `${new URL(url).host} does not publish its events through BiblioCommons.`, {
          hint: "Use ask_library to find events on this library's own website.",
          details: { url },
        });
      }
      return this.stamp(contract(RawEventsState, read.state, { contract: "events page", url }), url);
    });
  }

  async listEvents(id: string, params: EventParams): Promise<Sourced<EventResult>> {
    // The unfiltered page carries the vocabulary (branches, audiences, types) used to resolve filters.
    const vocab = (await this.eventsPage(id, new URLSearchParams())).data.entities;
    const audiences = Object.values(vocab.eventAudiences ?? {});
    const types = Object.values(vocab.eventTypes ?? {});
    const locations = Object.values(vocab.locations ?? {});

    const pick = <T extends { id: string; name: string }>(what: string, input: string, options: T[], extra: (o: T) => string[] = () => []) => {
      const hit = options.find((o) => o.id.toLowerCase() === input.toLowerCase()) ?? matchLabel(input, options, (o) => [o.name, ...extra(o)]);
      if (!hit) {
        throw new StacksError("INVALID_INPUT", `No ${what} matching "${input}" at this library.`, {
          hint: `Valid ${what} values are listed in details.options.`,
          details: { options: options.map((o) => o.name).sort().slice(0, 60) },
        });
      }
      return hit.id;
    };

    const qs = new URLSearchParams();
    if (params.branch) qs.set("locations", pick("branch", params.branch, locations));
    if (params.audience) qs.set("audiences", pick("audience", params.audience, audiences));
    if (params.event_type) qs.set("types", pick("event_type", params.event_type, types));
    if (params.start_date) qs.set("startDate", params.start_date);
    if (params.end_date) qs.set("endDate", params.end_date);
    if (params.query) qs.set("q", params.query);
    if (params.page > 1) qs.set("page", String(params.page));

    const page = await this.eventsPage(id, qs);
    const result = parseEvents(page.data, this.catalogUrl(id));
    result.filters = { audiences: audiences.map((a) => a.name).sort(), event_types: types.map((t) => t.name).sort() };
    return { data: result, source: page.source };
  }

  landmarks(id: string): Landmark[] {
    const base = this.catalogUrl(id);
    return [
      { name: "search page", url: `${base}/v2/search?query=harry%20potter&searchType=smart`, must_contain: ["Filter your results", "Search result items"] },
      { name: "events page", url: `${base}/v2/events`, must_contain: ["Event filters", "Event items"] },
      { name: "locations page", url: `${base}/v2/locations`, must_contain: ["Locations", "Get directions"] },
    ];
  }

  agentFallback(kind: "search" | "availability", id: string, arg: string) {
    if (kind === "search") {
      return {
        url: `${this.catalogUrl(id)}/v2/search?query=${encodeURIComponent(arg)}&searchType=smart`,
        goal: `This is a public library catalogue search for "${arg}". Extract the first 10 results on this page only. Do not log in, place holds or navigate away.`,
        output_schema: agentSchema(
          z.object({
            results: z.array(z.object({ title: z.string(), author: z.string().nullable(), format: z.string(), year: z.string().nullable(), availability: z.string().nullable(), holds: z.string().nullable() })),
          }),
        ),
      };
    }
    return {
      url: this.recordUrl(id, arg),
      goal: 'This is a public library title page. Open "Availability by location" and extract up to 40 copies, branches with an available copy first. Do not log in or place holds.',
      output_schema: agentSchema(
        z.object({
          title: z.string(),
          copies: z.array(z.object({ branch: z.string(), status: z.string(), call_number: z.string().nullable(), due_date: z.string().nullable() })),
        }),
      ),
    };
  }
}
