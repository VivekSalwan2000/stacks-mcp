/**
 * The promise this project makes: when the website changes, tools fail with a
 * clear, typed error that names what broke. They never return quietly wrong
 * or empty data. These tests simulate site changes by mutating recorded pages.
 */
import { describe, expect, it } from "vitest";
import { createContext } from "../src/core/context.js";
import { StacksError } from "../src/core/errors.js";
import { runHealth } from "../src/health/checks.js";
import { TOOLS } from "../src/tools/index.js";
import { fixture, FakeWeb, TEST_CONFIG } from "./helpers.js";

function setup() {
  const web = new FakeWeb();
  const ctx = createContext(TEST_CONFIG, web);
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
  return { web, ctx, tool };
}

async function failure(run: () => Promise<unknown>): Promise<StacksError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(StacksError);
    return err as StacksError;
  }
  throw new Error("expected the tool to fail, but it returned data");
}

describe("when the site changes", () => {
  it("search_catalog: a renamed field is reported by name", async () => {
    const { web, ctx, tool } = setup();
    const page = fixture("search");
    for (const bib of Object.values<any>(page.entities.bibs)) {
      bib.briefInfo.heading = bib.briefInfo.title; // the site renames `title`
      delete bib.briefInfo.title;
    }
    web.serve("/v2/search", page);
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
    expect(err.details.broken_fields?.join(" ")).toMatch(/briefInfo\.title/);
  });

  it("search_catalog: starts an Agent fallback and says so", async () => {
    const { web, ctx, tool } = setup();
    const page = fixture("search");
    delete page.search.catalogSearch.pagination;
    web.serve("/v2/search", page);
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
    expect(err.details.fallback_job_id).toMatch(/^search\./);
    expect(web.agentRuns).toHaveLength(1);
  });

  it("search_catalog: the page losing its embedded data is SITE_CHANGED, not 'no results'", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/search", null, {}, 200);
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
  });

  it("search_catalog: results pointing at missing records are not silently dropped", async () => {
    const { web, ctx, tool } = setup();
    const page = fixture("search");
    page.entities.bibs = {};
    web.serve("/v2/search", page);
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
  });

  it("check_availability: a missing availability request is detected", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/record/S234C3970025", fixture("record"), {}); // page loads, background request never fires
    const err = await failure(() => tool("check_availability").handler({ library: "tpl", title_id: "S234C3970025", on_shelf_only: false, limit: 15 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
    expect(err.details.broken_fields?.[0]).toMatch(/availability: not observed/);
  });

  it("check_availability: a changed copy shape is reported by name", async () => {
    const { web, ctx, tool } = setup();
    const avail = fixture("availability");
    for (const item of Object.values<any>(avail.entities.bibItems)) delete item.branch;
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: avail });
    const err = await failure(() => tool("check_availability").handler({ library: "tpl", title_id: "S234C3970025", on_shelf_only: false, limit: 15 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
    expect(err.details.broken_fields?.join(" ")).toMatch(/branch/);
  });

  it("list_events: an event with an unreadable shape fails the whole call", async () => {
    const { web, ctx, tool } = setup();
    const page = fixture("events");
    for (const ev of Object.values<any>(page.entities.events)) delete ev.definition.start;
    web.serve("/v2/events", page);
    const err = await failure(() => tool("list_events").handler({ library: "tpl", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
    expect(err.details.broken_fields?.join(" ")).toMatch(/definition\.start/);
  });
});

describe("false alarms and hidden failures", () => {
  it("a page that loads once without its data is read again, not reported as SITE_CHANGED", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/search", fixture("search"));
    web.blankFirst("/v2/search", 1);
    const out = (await tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx)) as any;
    expect(out.results.length).toBeGreaterThan(0);
    expect(web.usage.browser).toBe(2);
  });

  it("a page that keeps loading without its data is still SITE_CHANGED", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/search", fixture("search"));
    web.blankFirst("/v2/search", 2);
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
  });

  it("a title id from another library follows the site's redirect to this library's record", async () => {
    const { web, ctx, tool } = setup();
    // The site answers /record/<foreign id> with its own record for the same work.
    web.serve("/v2/record/S126C671306", fixture("record"), {}, 200, "https://tpl.bibliocommons.com/v2/record/S234C3970025");
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: fixture("availability") });
    const out = (await tool("check_availability").handler({ library: "tpl", title_id: "S126C671306", on_shelf_only: false, limit: 150 }, ctx)) as any;
    expect(out.title_id).toBe("S234C3970025");
    expect(out.branches.length).toBeGreaterThan(0);
  });

  it("an Agent fallback that cannot start is reported, not hidden", async () => {
    const { web, ctx, tool } = setup();
    const page = fixture("search");
    delete page.search.catalogSearch.pagination;
    web.serve("/v2/search", page);
    web.agentStartError = "output_schema rejected";
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("SITE_CHANGED");
    expect(err.details.fallback_job_id).toBeUndefined();
    expect(String(err.details.fallback)).toMatch(/could not be started: output_schema rejected/);
  });

  it("the Agent schemas Stacks sends use nullable: true, never a null type", async () => {
    const { ctx } = setup();
    for (const kind of ["search", "availability"] as const) {
      const sent = JSON.stringify(ctx.adapter.agentFallback(kind, "tpl", "dune").output_schema);
      expect(sent).toMatch(/"nullable":true/);
      expect(sent).not.toMatch(/"type":\[|"type":"null"|anyOf/);
    }
  });

  it("an Agent fallback that read nothing is a failed job, not an empty answer", async () => {
    const { web, ctx, tool } = setup();
    web.agentGet = async (runId) => ({ run_id: runId, status: "COMPLETED", result: { results: [] }, error: null, steps: 6 });
    const out = (await tool("get_job_result").handler({ job_id: "search.00000000-0000-4000-8000-000000000001" }, ctx)) as any;
    expect(out.status).toBe("failed");
    expect(out.result).toBeNull();
    expect(out.error).toMatch(/could not read any rows/);
  });

  it("health_check reads a partly rendered page again before failing it", async () => {
    const { web, ctx } = setup();
    let calls = 0;
    web.fetch = async (urls) => {
      const full = "Filter your results Search result items Event filters Event items Locations Get directions";
      const text = ++calls === 1 ? "Search result items Event filters Event items Locations Get directions" : full;
      return urls.map((url) => ({ url, final_url: url, title: null, text }));
    };
    const report = await runHealth(ctx, "tpl");
    const landmarks = report.checks.filter((c) => c.layer === "landmark");
    expect(landmarks.length).toBe(3);
    expect(landmarks.every((c) => c.status === "pass")).toBe(true);
    expect(calls).toBe(2);
  });

  it("health_check --deep says why the Agent diagnosis could not start", async () => {
    const { web, ctx } = setup();
    web.agentStartError = "output_schema rejected";
    const report = await runHealth(ctx, "tpl", { deep: true });
    expect(report.healthy).toBe(false);
    expect(report.diagnosis_job_id).toBeNull();
    expect(report.diagnosis_error).toMatch(/output_schema rejected/);
  });

  it("health_check --deep returns a diagnosis job when the Agent starts", async () => {
    const { web, ctx } = setup();
    const report = await runHealth(ctx, "tpl", { deep: true });
    expect(report.diagnosis_job_id).toMatch(/^diagnosis\./);
    expect(report.diagnosis_error).toBeNull();
    expect(JSON.stringify(web.agentRuns[0]!.output_schema)).not.toMatch(/"type":\[|"type":"null"/);
  });
});

describe("when the input is wrong, the error says how to fix it", () => {
  it("unknown library", async () => {
    const { ctx, tool } = setup();
    const err = await failure(() => tool("search_catalog").handler({ library: "no-such-library", query: "dune", search_type: "keyword", page: 1 }, ctx));
    expect(err.code).toBe("UNKNOWN_LIBRARY");
    expect(err.hint).toMatch(/find_library/);
  });

  it("missing title", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/record/", fixture("record-notfound"));
    const err = await failure(() => tool("check_availability").handler({ library: "tpl", title_id: "S234C0000001", on_shelf_only: false, limit: 15 }, ctx));
    expect(err.code).toBe("NOT_FOUND");
  });

  it("unknown audience lists the valid ones", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/events", fixture("events"));
    const err = await failure(() => tool("list_events").handler({ library: "tpl", audience: "martians", page: 1 }, ctx));
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.details.options).toContain("School Age Children (6-12)");
  });

  it("a library that does not run the events module is NOT_SUPPORTED", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/events", null, {}, 500);
    const err = await failure(() => tool("list_events").handler({ library: "seattle", page: 1 }, ctx));
    expect(err.code).toBe("NOT_SUPPORTED");
  });
});

describe("happy path through the tools", () => {
  it("check_availability filters by branch and by on-shelf", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: fixture("availability") });
    const all = (await tool("check_availability").handler({ library: "tpl", title_id: "S234C3970025", on_shelf_only: false, limit: 150 }, ctx)) as any;
    expect(all.branches.length).toBe(all.branches_holding);
    const shelf = (await tool("check_availability").handler({ library: "Toronto", title_id: "S234C3970025", on_shelf_only: true, limit: 150 }, ctx)) as any;
    expect(shelf.library).toBe("tpl");
    expect(shelf.branches.every((b: any) => b.copies_on_shelf > 0)).toBe(true);
    const one = (await tool("check_availability").handler({ library: "tpl", title_id: "S234C3970025", branch: "agincourt", on_shelf_only: false, limit: 15 }, ctx)) as any;
    expect(one.branches.map((b: any) => b.branch_code)).toEqual(["AG"]);
    expect(one.source.cached).toBe(true);
    expect(web.usage.browser).toBe(1); // three calls, one page load
  });

  it("estimate_wait says it is available now when a copy is on a shelf", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: fixture("availability") });
    const r = (await tool("estimate_wait").handler({ library: "tpl", title_id: "S234C3970025", loan_days: 21 }, ctx)) as any;
    expect(r.available_now).toBe(true);
    expect(r.estimated_wait_days).toEqual({ low: 0, likely: 0, high: 0 });
  });

  it("estimate_wait computes a queue estimate when nothing is on a shelf", async () => {
    const { web, ctx, tool } = setup();
    const avail = fixture("availability");
    for (const item of Object.values<any>(avail.entities.bibItems)) {
      if (item.availability.status === "AVAILABLE") Object.assign(item, { dueDate: "2099-01-10", availability: { ...item.availability, status: "CHECKED_OUT", statusType: "UNAVAILABLE" } });
    }
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: avail });
    const r = (await tool("estimate_wait").handler({ library: "tpl", title_id: "S234C3970025", loan_days: 21 }, ctx)) as any;
    expect(r.available_now).toBe(false);
    expect(r.holds).toBe(178);
    expect(r.estimated_wait_days.likely).toBeGreaterThan(0);
    expect(r.estimated_wait_days.low).toBeLessThanOrEqual(r.estimated_wait_days.likely);
    expect(r.basis).toMatch(/number 179 in the queue/);
  });
});
