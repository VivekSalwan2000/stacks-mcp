/**
 * The health check: how Stacks notices that a library website changed.
 *
 * Three layers, cheapest first:
 *   1. Landmarks (TinyFish Fetch)   Do the pages still exist and still show their key sections?
 *   2. Contracts (TinyFish Browser) Does every tool still return valid, non-empty, typed data
 *                                   for known-good queries (canaries)?
 *   3. Diagnosis (TinyFish Agent)   If something failed, an Agent opens the page and describes
 *                                   what it sees, so a maintainer knows what changed.
 *
 * Run it from an agent (health_check tool), a terminal (`stacks-mcp health`) or CI
 * (.github/workflows/canary.yml, which opens an issue on failure).
 */
import { z } from "zod";
import { createContext, type Context } from "../core/context.js";
import { StacksError, toStacksError } from "../core/errors.js";
import { agentSchema, startJob } from "../core/jobs.js";
import type { Endpoint } from "../core/web.js";

/** The BiblioCommons release these contracts were last verified against. */
export const KNOWN_PLATFORM_VERSION = "9.38.3";

export const CheckSchema = z.object({
  name: z.string(),
  layer: z.enum(["landmark", "contract", "platform"]),
  engine: z.enum(["fetch", "browser"]),
  status: z.enum(["pass", "fail", "warn", "skipped"]),
  ms: z.number().int(),
  detail: z.string(),
  error_code: z.string().nullable(),
  broken_fields: z.array(z.string()),
  url: z.string().nullable(),
});
export type Check = z.infer<typeof CheckSchema>;

export interface HealthReport {
  healthy: boolean;
  library: string;
  summary: string;
  platform_version: string | null;
  verified_platform_version: string;
  checks: Check[];
  diagnosis_job_id: string | null;
  /** Why the Agent diagnosis could not be started, if `deep` was asked for and it failed. */
  diagnosis_error: string | null;
  tinyfish_calls: Record<Endpoint, number>;
  checked_at: string;
}

async function contractCheck(name: string, url: string | null, run: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  const base = { name, layer: "contract" as const, engine: "browser" as const, url, error_code: null, broken_fields: [] as string[] };
  try {
    const detail = await run();
    return { ...base, status: "pass", ms: Date.now() - started, detail };
  } catch (err) {
    const e = toStacksError(err);
    return {
      ...base,
      status: e.code === "NOT_SUPPORTED" ? "skipped" : "fail",
      ms: Date.now() - started,
      detail: e.message,
      error_code: e.code,
      broken_fields: e.details.broken_fields ?? [],
      url: e.details.url ?? url,
    };
  }
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new StacksError("SITE_CHANGED", message, { details: { contract: "canary", broken_fields: [message] } });
}

export async function runHealth(ctx: Context, library: string, opts: { deep?: boolean } = {}): Promise<HealthReport> {
  // A private cache, so a health check always reads the live site.
  const live = createContext(ctx.config, ctx.web);
  const { adapter, web } = live;
  const before = { ...web.usage };
  const base = adapter.catalogUrl(library);
  const checks: Check[] = [];
  let platformVersion: string | null = null;
  let canaryTitle: string | null = null;

  checks.push(
    await contractCheck("search_catalog returns typed results", `${base}/v2/search?query=harry+potter`, async () => {
      const { data } = await adapter.search(library, { query: "harry potter", search_type: "keyword", page: 1 });
      expect(data.total >= 5, `search for "harry potter" returned ${data.total} results, expected at least 5`);
      expect(data.titles.length >= 5, `search page listed ${data.titles.length} titles, expected at least 5`);
      expect(data.titles.every((t) => t.title && /^S\d+C\d+$/.test(t.title_id)), "a search result is missing its title or title_id");
      expect(data.titles.some((t) => t.availability.status !== "unknown"), "no search result carries availability data");
      canaryTitle = (data.titles.find((t) => t.format.code === "BK" && (t.availability.total_copies ?? 0) > 0) ?? data.titles[0])!.title_id;
      return `${data.total} results; first: "${data.titles[0]!.title}" (${data.titles[0]!.format.label})`;
    }),
  );

  checks.push(
    await contractCheck("search_catalog tells 'no results' apart from 'broken'", `${base}/v2/search?query=zzqxqxzzy`, async () => {
      const { data } = await adapter.search(library, { query: "zzqxqxzzy", search_type: "keyword", page: 1 });
      expect(data.total === 0 && data.titles.length === 0, `a nonsense query returned ${data.total} results, expected 0`);
      return "nonsense query returns 0 results without error";
    }),
  );

  checks.push(
    await contractCheck("check_availability returns copy-level data", canaryTitle ? adapter.recordUrl(library, canaryTitle) : null, async () => {
      expect(canaryTitle !== null, "no canary title: the search check failed first");
      const { data } = await adapter.getTitle(library, canaryTitle!);
      expect(!!data.details.title, "title page has no title");
      expect(data.branches.length >= 1, "title page lists no branches holding the title");
      expect(data.branches.every((b) => b.branch_name && b.copies.length > 0), "a branch is missing its name or its copies");
      const copies = data.branches.reduce((n, b) => n + b.copies_total, 0);
      return `"${data.details.title}": ${copies} copies at ${data.branches.length} branches, ${data.summary.holds ?? 0} holds`;
    }),
  );

  checks.push(
    await contractCheck("list_branches returns branches with hours", `${base}/v2/locations`, async () => {
      const { data } = await adapter.listBranches(library);
      expect(data.length >= 1, "locations page lists no branches");
      expect(data.some((b) => b.hours.some((h) => h.open && h.close)), "no branch has opening hours");
      expect(data.some((b) => b.address), "no branch has an address");
      return `${data.length} branches; ${data.filter((b) => b.open_now).length} open now`;
    }),
  );

  checks.push(
    await contractCheck("list_events returns typed events", `${base}/v2/events`, async () => {
      const { data } = await adapter.listEvents(library, { page: 1 });
      expect(data.events.length >= 1 || data.total === 0, "events page reports events but lists none");
      expect(data.events.every((e) => e.title && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(e.start)), "an event is missing its title or has an unreadable start time");
      return `${data.total} upcoming events; ${data.filters.audiences.length} audiences, ${data.filters.event_types.length} event types`;
    }),
  );

  // Layer 1: page landmarks via Fetch (one request for all pages).
  const skipped = new Set(checks.filter((c) => c.status === "skipped").map((c) => c.url));
  const landmarks = adapter.landmarks(library).filter((l) => !skipped.has(l.url.split("?")[0]!) && !skipped.has(l.url));
  const started = Date.now();
  try {
    let pages = await web.fetch(landmarks.map((l) => l.url));
    // Fetch occasionally returns a page partly rendered. Read the failing pages once more
    // before reporting them, so a one-off does not raise a false alarm.
    const intact = (l: (typeof landmarks)[number], from: typeof pages) => {
      const text = (from.find((p) => p.url === l.url)?.text ?? "").toLowerCase();
      return !!text && l.must_contain.every((m) => text.includes(m.toLowerCase()));
    };
    const again = landmarks.filter((l) => !intact(l, pages));
    if (again.length) {
      const second = await web.fetch(again.map((l) => l.url)).catch(() => []);
      const better = new Set(again.filter((l) => intact(l, second)).map((l) => l.url));
      pages = [...pages.filter((p) => !better.has(p.url)), ...second.filter((p) => better.has(p.url))];
    }
    for (const l of landmarks) {
      const page = pages.find((p) => p.url === l.url);
      const text = (page?.text ?? "").toLowerCase();
      const missing = l.must_contain.filter((m) => !text.includes(m.toLowerCase()));
      checks.unshift({
        name: `${l.name} is reachable and intact`,
        layer: "landmark",
        engine: "fetch",
        status: page?.text && !missing.length ? "pass" : "fail",
        ms: Date.now() - started,
        detail: !page?.text ? `could not read the page (${page?.error ?? "no content"})` : missing.length ? `missing section(s): ${missing.join(", ")}` : `found: ${l.must_contain.join(", ")}`,
        error_code: page?.text && !missing.length ? null : "SITE_CHANGED",
        broken_fields: missing.map((m) => `page text: "${m}" not found`),
        url: l.url,
      });
    }
  } catch (err) {
    const e = toStacksError(err);
    checks.unshift({ name: "pages are reachable", layer: "landmark", engine: "fetch", status: "fail", ms: Date.now() - started, detail: e.message, error_code: e.code, broken_fields: [], url: null });
  }

  // Platform version drift: an early warning that contracts may be about to break.
  try {
    platformVersion = (await adapter.getLibrary(library)).data.platform_version;
    const same = platformVersion === KNOWN_PLATFORM_VERSION;
    checks.push({
      name: "platform version",
      layer: "platform",
      engine: "browser",
      status: same || !platformVersion ? "pass" : "warn",
      ms: 0,
      detail: same ? `BiblioCommons ${platformVersion} (the verified version)` : `BiblioCommons is now ${platformVersion ?? "unknown"}; contracts were last verified on ${KNOWN_PLATFORM_VERSION}`,
      error_code: null,
      broken_fields: [],
      url: null,
    });
  } catch {
    // Already reported by the search contract check.
  }

  const failed = checks.filter((c) => c.status === "fail");
  let diagnosis: string | null = null;
  let diagnosisError: string | null = null;
  if (opts.deep && failed.length) {
    const target = failed.find((c) => c.url) ?? failed[0]!;
    diagnosis = await startJob(web, "diagnosis", {
      url: target.url ?? base,
      goal:
        `A program that reads this public library page expected: ${target.name}. It failed with: ${target.detail}. ` +
        "Look at this page and report what a maintainer needs to know. Do not log in or submit forms.",
      output_schema: agentSchema(
        z.object({
          page_loads: z.boolean(),
          blocked_or_captcha: z.boolean(),
          maintenance_or_error_banner: z.string().nullable(),
          main_sections_visible: z.array(z.string()),
          what_looks_different: z.string().describe("What on the page explains the failure."),
        }),
      ),
    }).catch((err: unknown) => {
      diagnosisError = (err as Error).message;
      return null;
    });
  }

  const calls = Object.fromEntries((Object.keys(web.usage) as Endpoint[]).map((k) => [k, web.usage[k] - before[k]])) as Record<Endpoint, number>;
  const counts = (s: Check["status"]) => checks.filter((c) => c.status === s).length;
  return {
    healthy: failed.length === 0,
    library,
    summary: failed.length
      ? `BROKEN: ${failed.length} of ${checks.length} checks failed (${failed.map((f) => f.name).join("; ")}).`
      : `Healthy: ${counts("pass")} passed, ${counts("warn")} warning(s), ${counts("skipped")} skipped.`,
    platform_version: platformVersion,
    verified_platform_version: KNOWN_PLATFORM_VERSION,
    checks,
    diagnosis_job_id: diagnosis,
    diagnosis_error: diagnosisError,
    tinyfish_calls: calls,
    checked_at: new Date().toISOString(),
  };
}

export function formatReport(r: HealthReport): string {
  const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skipped: "SKIP" } as const;
  const lines = [`Stacks health check: ${r.library}  (${r.checked_at})`, r.summary, ""];
  for (const c of r.checks) {
    lines.push(`  [${icon[c.status]}] ${c.name}  (${c.engine}, ${c.ms} ms)`);
    lines.push(`         ${c.detail}`);
    for (const f of c.broken_fields) lines.push(`         broken: ${f}`);
  }
  if (r.diagnosis_job_id) lines.push("", `Agent diagnosis started: ${r.diagnosis_job_id}`);
  if (r.diagnosis_error) lines.push("", `Agent diagnosis could not be started: ${r.diagnosis_error}`);
  lines.push("", `TinyFish calls: ${Object.entries(r.tinyfish_calls).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return lines.join("\n");
}
