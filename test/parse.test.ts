import { describe, expect, it } from "vitest";
import { RawAvailabilityResponse, RawEventsState, RawLocationsState, RawRecordState, RawSearchState } from "../src/adapters/bibliocommons/contracts.js";
import { parseAvailability, parseBranches, parseEvents, parseRecord, parseSearch } from "../src/adapters/bibliocommons/parse.js";
import { EventSchema, BranchSchema, TitleDetailsSchema, TitleSchema, BranchAvailabilitySchema } from "../src/schemas.js";
import { fixture } from "./helpers.js";

const BASE = "https://tpl.bibliocommons.com";

describe("search results", () => {
  const result = parseSearch(RawSearchState.parse(fixture("search")), BASE);

  it("returns typed titles that satisfy the public schema", () => {
    expect(result.total).toBe(13);
    expect(result.titles).toHaveLength(13);
    for (const t of result.titles) expect(() => TitleSchema.parse(t)).not.toThrow();
  });

  it("maps format codes, ratings and availability", () => {
    const t = result.titles.find((x) => x.title_id === "S234C2504662")!;
    expect(t.title).toBe("Dune Road");
    expect(t.authors).toEqual(["Green, Jane"]);
    expect(t.format).toEqual({ code: "BK", label: "Book" });
    expect(t.rating).toEqual({ average_out_of_5: 3.25, count: 53 });
    expect(t.availability).toMatchObject({ status: "available", total_copies: 6, available_copies: 6 });
    expect(t.url).toBe(`${BASE}/v2/record/S234C2504662`);
  });

  it("treats zero results as an answer, not an error", () => {
    const empty = parseSearch(RawSearchState.parse(fixture("search-zero")), BASE);
    expect(empty).toMatchObject({ total: 0, titles: [], did_you_mean: "zizzy" });
  });
});

describe("title record and availability", () => {
  it("extracts details from the title page", () => {
    const d = parseRecord(RawRecordState.parse(fixture("record")), "S234C3970025", BASE);
    expect(() => TitleDetailsSchema.parse(d)).not.toThrow();
    expect(d.title).toBe("Project Hail Mary");
    expect(d.contributors[0]).toEqual({ name: "Weir, Andy", roles: ["Author"] });
    expect(d.isbns).toContain("9798217299461");
    expect(d.description).toMatch(/Ryland Grace/);
    expect(d.other_formats.length).toBeGreaterThan(0);
  });

  it("reports a missing title as NOT_FOUND", () => {
    expect(() => parseRecord(RawRecordState.parse(fixture("record-notfound")), "S234C0000001", BASE)).toThrowError(/No title with id/);
  });

  it("groups copies by branch, on-shelf branches first", () => {
    const { summary, branches } = parseAvailability(RawAvailabilityResponse.parse(fixture("availability")), "S234C3970025");
    for (const b of branches) expect(() => BranchAvailabilitySchema.parse(b)).not.toThrow();
    expect(summary).toMatchObject({ status: "available", total_copies: 216, holds: 178 });
    expect(branches[0]!.branch_name).toBe("North York Central Library");
    expect(branches[0]!.copies_on_shelf).toBeGreaterThan(0);
    const agincourt = branches.find((b) => b.branch_code === "AG")!;
    expect(agincourt.copies.some((c) => c.status === "checked_out" && /^\d{4}-\d{2}-\d{2}$/.test(c.due_date ?? ""))).toBe(true);
    expect(agincourt.next_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("branches", () => {
  const state = RawLocationsState.parse(fixture("locations"));

  it("returns typed branches with hours and services", () => {
    const branches = parseBranches(state, new Date("2026-11-11T17:00:00Z"));
    for (const b of branches) expect(() => BranchSchema.parse(b)).not.toThrow();
    const yorkville = branches.find((b) => b.branch_code === "YO")!;
    expect(yorkville.address).toBe("22 Yorkville Avenue");
    expect(yorkville.hours.find((h) => h.day === "sunday")).toEqual({ day: "sunday", open: "12:00", close: "17:00" });
    expect(yorkville.services).toContain("Meeting Room");
    expect(yorkville.accessibility).toMatch(/Wheelchair accessible furniture/);
  });

  it("computes open_now in the branch's own time zone", () => {
    const at = (iso: string) => parseBranches(state, new Date(iso)).find((b) => b.branch_code === "YO")!;
    expect(at("2026-11-11T17:00:00Z").open_now).toBe(true); // Wed 12:00 Toronto
    expect(at("2026-11-12T03:00:00Z").open_now).toBe(false); // Wed 22:00 Toronto
    expect(at("2026-11-15T16:30:00Z").open_now).toBe(false); // Sun 11:30 Toronto, opens at 12:00
  });

  it("applies special hours on holidays", () => {
    const eve = parseBranches(state, new Date("2026-12-24T19:00:00Z")).find((b) => b.branch_code === "YO")!; // 14:00 Toronto
    expect(eve.today.close).toBe("13:00");
    expect(eve.today.note).toMatch(/Christmas Eve/);
    expect(eve.open_now).toBe(false);
  });
});

describe("events", () => {
  it("returns typed events with resolved names and clean text", () => {
    const r = parseEvents(RawEventsState.parse(fixture("events")), BASE);
    expect(r.total).toBe(1);
    const e = r.events[0]!;
    expect(() => EventSchema.parse(e)).not.toThrow();
    expect(e).toMatchObject({ title: "Sunday Family Crafts", start: "2026-11-15T15:00", end: "2026-11-15T16:00", branch_code: "YO", branch_name: "Yorkville", registration_required: false });
    expect(e.audiences).toEqual(["Preschool Children (0-5)", "School Age Children (6-12)"]);
    expect(e.description).not.toMatch(/[<>]|&lt;|&nbsp;/);
  });

  it("never exposes staff-only fields", () => {
    const out = JSON.stringify(parseEvents(RawEventsState.parse(fixture("events")), BASE));
    expect(out).not.toMatch(/staffNotes|@tpl\.ca/);
  });
});

describe("availability summary and ISBNs", () => {
  it("a title whose only copy in is for in-library use is not called available", async () => {
    const { summarize } = await import("../src/adapters/bibliocommons/parse.js");
    const s = summarize({ status: "AVAILABLE", statusType: "AVAILABLE", totalCopies: 217, availableCopies: 1, heldCopies: 177, onOrderCopies: 0, libraryUseOnly: true, localisedStatus: "LIBRARY_USE_ONLY_AT_THIS_TIME" } as any);
    expect(s.status).toBe("library_use_only");
    expect(s.holds).toBe(177);
  });
  it("'available' with 0 of 0 copies reports the counts as unknown, not zero", async () => {
    const { summarize } = await import("../src/adapters/bibliocommons/parse.js");
    const s = summarize({ status: "AVAILABLE", statusType: "AVAILABLE", totalCopies: 0, availableCopies: 0, heldCopies: 0, onOrderCopies: 0 } as any);
    expect(s).toMatchObject({ status: "available", total_copies: null, available_copies: null });
    const real = summarize({ status: "AVAILABLE", totalCopies: 13, availableCopies: 3, heldCopies: 1, onOrderCopies: 0 } as any);
    expect(real).toMatchObject({ status: "available", total_copies: 13, available_copies: 3 });
    const none = summarize({ status: "UNAVAILABLE", statusType: "UNAVAILABLE", totalCopies: 7, availableCopies: 0, heldCopies: 24 } as any);
    expect(none).toMatchObject({ status: "all_copies_in_use", total_copies: 7, available_copies: 0 });
  });
  it("ISBNs lose their notes and prices and are listed once", async () => {
    const { cleanIsbns } = await import("../src/adapters/bibliocommons/parse.js");
    expect(cleanIsbns(["9780684830421 (hbk.)", "0684830426 (hbk.)", "9780684830421 $25.00", "0684830426 $26.00", "9780593438374(paperback)", "044100590X (Ace)", "978-0-441-01359-3 (pbk.)", "not an isbn"])).toEqual(["9780684830421", "0684830426", "9780593438374", "044100590X", "9780441013593"]);
  });
});
