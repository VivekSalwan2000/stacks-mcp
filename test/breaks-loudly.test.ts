/**
 * The promise this project makes: when the website changes, tools fail with a
 * clear, typed error that names what broke. They never return quietly wrong
 * or empty data. These tests simulate site changes by mutating recorded pages.
 */
import { describe, expect, it } from "vitest";
import { createContext } from "../src/core/context.js";
import { StacksError } from "../src/core/errors.js";
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
