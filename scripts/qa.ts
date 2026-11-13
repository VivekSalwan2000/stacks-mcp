/**
 * QA matrix: drives the built server (dist/index.js) over real stdio MCP and
 * checks protocol conformance, input validation, every tool on several
 * libraries, error paths, data invariants, caching and concurrency.
 *
 *   npm run build && npx tsx scripts/qa.ts [--group protocol,validation,...] [--out results.json]
 *
 * Groups: protocol validation functional errors invariants cache concurrency
 *         reliability sweep watch agent health
 * The MCP SDK client validates every structured result against the tool's
 * published output schema, so a schema drift fails the case.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const groups = new Set((opt("--group") ?? "protocol,validation,functional,errors,invariants,cache,concurrency").split(","));
const outFile = opt("--out");

const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "pipe" });
const client = new Client({ name: "stacks-qa", version: "0.0.0" });
await client.connect(transport);

interface Result { id: string; group: string; tool: string; args: unknown; expect: string; outcome: "pass" | "fail"; got: string; ms: number; note: string }
const results: Result[] = [];
const emails = new Map<string, Set<string>>();
let staffKeyHits = 0;

function scan(value: unknown, path: string): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const field = path.replace(/\[\d+\]/g, "[]");
      if (!emails.has(field)) emails.set(field, new Set());
      emails.get(field)!.add(m[0]);
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${path}[${i}]`));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/staff/i.test(k)) staffKeyHits++;
      scan(v, path ? `${path}.${k}` : k);
    }
  }
}

type Check = (r: any) => string[] | string | void;
interface Expect { error?: string | string[]; rejects?: boolean; check?: Check }

async function raw(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; code: string; text: string; ms: number; thrown: boolean }> {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 240_000 });
    const ms = Date.now() - t0;
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
    if (res.isError) {
      let code = "";
      try { code = JSON.parse(text).error?.code ?? ""; } catch { code = /validation/i.test(text) ? "MCP_INPUT_VALIDATION" : "UNSTRUCTURED_ERROR"; }
      return { ok: false, data: null, code, text, ms, thrown: false };
    }
    scan(res.structuredContent, tool);
    return { ok: true, data: res.structuredContent, code: "", text, ms, thrown: false };
  } catch (err) {
    const e = err as { code?: number; message?: string };
    return { ok: false, data: null, code: `MCP_${e.code ?? "THROWN"}`, text: e.message ?? String(err), ms: Date.now() - t0, thrown: true };
  }
}

async function run(group: string, id: string, tool: string, args: Record<string, unknown>, expect: Expect = {}): Promise<any> {
  const r = await raw(tool, args);
  let outcome: "pass" | "fail" = "pass";
  let note = "";
  let expectText = "success";
  if (expect.rejects) {
    expectText = "rejected before any web call";
    const rejected = !r.ok && (r.code === "INVALID_INPUT" || r.code.startsWith("MCP_"));
    if (!rejected) { outcome = "fail"; note = r.ok ? "accepted invalid input" : `wrong error ${r.code}`; }
    else note = r.text.replace(/\s+/g, " ").slice(0, 160);
  } else if (expect.error) {
    const want = Array.isArray(expect.error) ? expect.error : [expect.error];
    expectText = `error ${want.join(" or ")}`;
    if (r.ok) { outcome = "fail"; note = "succeeded, expected an error"; }
    else if (!want.includes(r.code)) { outcome = "fail"; note = `got ${r.code}: ${r.text.slice(0, 200)}`; }
    else {
      const parsed = JSON.parse(r.text).error;
      note = parsed.message.slice(0, 160);
      if (!parsed.hint) { outcome = "fail"; note += " [no hint]"; }
    }
  } else if (!r.ok) {
    outcome = "fail";
    note = `${r.code}: ${r.text.replace(/\s+/g, " ").slice(0, 260)}`;
  } else if (expect.check) {
    try {
      const problems = expect.check(r.data);
      const list = Array.isArray(problems) ? problems : problems ? [problems] : [];
      const bad = list.filter((p) => !p.startsWith("info:"));
      if (bad.length) outcome = "fail";
      note = list.join("; ").slice(0, 400);
    } catch (err) {
      outcome = "fail";
      note = `check threw: ${(err as Error).message}`;
    }
  }
  const got = r.ok ? `ok${r.data?.source?.cached ? " (cached)" : ""}` : r.code;
  results.push({ id, group, tool, args, expect: expectText, outcome, got, ms: r.ms, note });
  console.log(`${outcome === "pass" ? "pass" : "FAIL"} ${id.padEnd(8)} ${tool} ${JSON.stringify(args).slice(0, 90)} -> ${got} ${r.ms}ms ${note ? `| ${note.slice(0, 200)}` : ""}`);
  return r.ok ? r.data : null;
}

function record(group: string, id: string, what: string, pass: boolean, note: string, ms = 0): void {
  results.push({ id, group, tool: what, args: {}, expect: "holds", outcome: pass ? "pass" : "fail", got: pass ? "ok" : "violated", ms, note });
  console.log(`${pass ? "pass" : "FAIL"} ${id.padEnd(8)} ${what} | ${note.slice(0, 220)}`);
}

/* ---------- invariant checkers ---------- */
const availOk = (a: any, where: string): string[] => {
  const p: string[] = [];
  if (a.total_copies !== null && a.available_copies !== null && a.available_copies > a.total_copies) p.push(`${where}: available > total`);
  if ([a.total_copies, a.available_copies, a.holds].some((n) => n !== null && n < 0)) p.push(`${where}: negative count`);
  if (a.status === "available" && a.available_copies === 0) p.push(`${where}: status available with 0 available copies`);
  if ((a.total_copies === null) !== (a.available_copies === null)) p.push(`${where}: only one of the two counts is null`);
  return p;
};
const searchOk = (min = 1): Check => (r) => {
  const p: string[] = [];
  if (r.total < min) p.push(`total ${r.total} < ${min}`);
  if (r.results.length > 20) p.push("more than 20 results on a page");
  const ids = new Set<string>();
  for (const t of r.results) {
    if (!/^S\d+C\d+$/.test(t.title_id)) p.push(`odd title_id ${t.title_id}`);
    if (ids.has(t.title_id)) p.push(`duplicate ${t.title_id}`);
    ids.add(t.title_id);
    if (!t.title?.trim()) p.push("empty title");
    if (/&[a-z]+;|<[a-z/]/i.test(`${t.title} ${t.subtitle ?? ""}`)) p.push(`html in title: ${t.title}`);
    p.push(...availOk(t.availability, t.title_id));
    if (!t.url.includes(t.title_id)) p.push("url does not match id");
  }
  p.push(`info: ${r.total} total, ${r.results.length} on page`);
  return p;
};
const hhmm = /^\d{2}:\d{2}$/;
const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/; // all-day events carry a date only

/* ================= PROTOCOL ================= */
if (groups.has("protocol")) {
  const info = client.getServerVersion();
  record("protocol", "P-01", "initialize: server identity", info?.name === "stacks" && /^\d+\.\d+\.\d+$/.test(info?.version ?? ""), JSON.stringify(info));
  record("protocol", "P-02", "initialize: instructions present", (client.getInstructions() ?? "").length > 100, `${(client.getInstructions() ?? "").length} chars`);
  const caps = client.getServerCapabilities();
  record("protocol", "P-03", "initialize: tools capability", !!caps?.tools, JSON.stringify(caps));
  const { tools } = await client.listTools();
  record("protocol", "P-04", "tools/list: 14 tools", tools.length === 14, tools.map((t) => t.name).join(", "));
  const bad: string[] = [];
  for (const t of tools) {
    if (!/^[a-z_]{3,40}$/.test(t.name)) bad.push(`${t.name}: name style`);
    if (!t.title) bad.push(`${t.name}: no title`);
    if ((t.description ?? "").length < 60) bad.push(`${t.name}: thin description`);
    if (t.inputSchema?.type !== "object") bad.push(`${t.name}: input schema`);
    if (!t.outputSchema) bad.push(`${t.name}: no output schema`);
    if (!t.annotations || t.annotations.readOnlyHint === undefined) bad.push(`${t.name}: no annotations`);
    for (const [k, v] of Object.entries((t.inputSchema as any).properties ?? {})) if (!(v as any).description && !["near_longitude", "limit", "search_type"].includes(k)) bad.push(`${t.name}.${k}: no description`);
  }
  record("protocol", "P-05", "tools/list: every tool has title, description, typed input and output, annotations", bad.length === 0, bad.join("; ") || "all 14 complete");
  const writers = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
  record("protocol", "P-06", "annotations: only watch_title and cancel_watch are writers", writers.join(",") === "cancel_watch,watch_title", `writers: ${writers.join(", ")}`);
  const cancel = tools.find((t) => t.name === "cancel_watch");
  record("protocol", "P-07", "annotations: cancel_watch marked destructive", cancel?.annotations?.destructiveHint === true, `destructiveHint=${cancel?.annotations?.destructiveHint}`);
  const unknown = await raw("no_such_tool", {});
  record("protocol", "P-08", "tools/call: unknown tool is rejected", !unknown.ok, `${unknown.code} ${unknown.text.slice(0, 80)}`);
  const t0 = Date.now();
  await client.ping();
  record("protocol", "P-09", "ping", true, `${Date.now() - t0} ms`);
  const sizes = tools.map((t) => JSON.stringify(t).length);
  record("protocol", "P-10", "tools/list payload size", sizes.reduce((a, b) => a + b, 0) < 60_000, `${sizes.reduce((a, b) => a + b, 0)} bytes for 14 tool definitions`);
}

/* ================= INPUT VALIDATION ================= */
if (groups.has("validation")) {
  const V = (id: string, tool: string, args: Record<string, unknown>) => run("validation", id, tool, args, { rejects: true });
  await V("V-01", "search_catalog", { library: "tpl" });
  await V("V-02", "search_catalog", { library: "tpl", query: "" });
  await V("V-03", "search_catalog", { library: "tpl", query: "dune", page: 0 });
  await V("V-04", "search_catalog", { library: "tpl", query: "dune", page: 51 });
  await V("V-05", "search_catalog", { library: "tpl", query: "dune", search_type: "isbn" });
  await V("V-06", "search_catalog", { library: "tpl", query: 12345 });
  await V("V-07", "search_catalog", { library: "tpl", query: "dune", format: "vhs_tape" });
  await V("V-08", "check_availability", { library: "tpl", title_id: "abc" });
  await V("V-09", "check_availability", { library: "tpl", title_id: "../../etc/passwd" });
  await V("V-10", "check_availability", { library: "tpl", title_id: "S234C3970025", limit: 0 });
  await V("V-11", "check_availability", { library: "tpl", title_id: "S234C3970025", limit: 151 });
  await V("V-12", "get_title", { library: "tpl" });
  await V("V-13", "get_title", { library: "tpl", title_id: "S234C3970025?x=1" });
  await V("V-14", "estimate_wait", { library: "tpl", title_id: "S234C3970025", loan_days: 0 });
  await V("V-15", "list_branches", { library: "tpl", near_latitude: 43.6 });
  await V("V-16", "list_branches", { library: "tpl", near_latitude: 91, near_longitude: 0 });
  await V("V-17", "list_branches", { library: "tpl", limit: 201 });
  await V("V-18", "get_branch", { library: "tpl" });
  await V("V-19", "get_branch", { library: "tpl", branch: "" });
  await V("V-20", "list_events", { library: "tpl", start_date: "12/11/2026" });
  await V("V-21", "list_events", { library: "tpl", start_date: "2026-12-10", end_date: "2026-12-01" });
  await V("V-22", "list_events", { library: "tpl", page: 0 });
  await V("V-23", "list_events", { library: "tpl", start_date: "2026-13-45" });
  await V("V-24", "get_job_result", { job_id: "nonsense" });
  await V("V-25", "get_job_result", { job_id: "evil.123" });
  await V("V-26", "get_job_result", {});
  await V("V-27", "watch_title", { library: "tpl", title_id: "S234C3970025", webhook_url: "not a url" });
  await V("V-28", "watch_title", { library: "tpl", title_id: "S234C3970025", webhook_url: "http://insecure.example.com/hook" });
  await V("V-29", "watch_title", { library: "tpl", title_id: "S234C3970025", check_every: "minute" });
  await V("V-30", "watch_title", { library: "tpl", title_id: "S234C3970025", webhook_url: "https://localhost/hook" });
  await V("V-31", "cancel_watch", {});
  await V("V-32", "ask_library", { library: "tpl" });
  await V("V-33", "ask_library", { library: "tpl", question: "" });
  await V("V-34", "find_library", {});
  await V("V-35", "find_library", { query: "" });
  await V("V-36", "search_catalog", { query: "dune" });
  await V("V-37", "health_check", { library: "tpl", deep: "yes" });
}

/* ================= FUNCTIONAL ================= */
const seeds: Record<string, { title_id?: string; ebook_id?: string; branch?: { code: string; name: string } }> = {};
if (groups.has("functional")) {
  const F = (id: string, tool: string, args: Record<string, unknown>, check?: Check) => run("functional", id, tool, args, { check });
  // find_library
  const one = (idWanted: string): Check => (r) => (r.matches[0]?.library_id === idWanted ? [] : [`first match ${r.matches[0]?.library_id ?? "none"}, wanted ${idWanted}`]);
  await F("F-01", "find_library", { query: "tpl" }, one("tpl"));
  await F("F-02", "find_library", { query: "toronto public library" }, one("tpl"));
  await F("F-03", "find_library", { query: "  VANCOUVER  " }, one("vpl"));
  await F("F-04", "find_library", { query: "Chicago" }, one("chipublib"));
  await F("F-05", "find_library", { query: "San Francisco" }, one("sfpl"));
  await F("F-06", "find_library", { query: "Boston Public Library" }, one("bpl"));
  await F("F-07", "find_library", { query: "Ottawa" }, one("ottawa"));
  await F("F-08", "find_library", { query: "Christchurch" }, one("christchurch"));
  await F("F-09", "find_library", { query: "library" }, (r) => [`info: ${r.matches.length} matches for a vague query`]);
  await F("F-10", "find_library", { query: "New York Public Library" }, (r) => [`info: ${r.matches.length} matches: ${r.matches.map((m: any) => m.library_id).join(",")}; note=${r.note}`]);

  let n = 10;
  for (const [lib, book, author] of [["tpl", "Project Hail Mary", "Atwood, Margaret"], ["vpl", "Dune", "Le Guin, Ursula"], ["chipublib", "The Great Gatsby", "Morrison, Toni"]] as const) {
    const s = await F(`F-${++n}`, "search_catalog", { library: lib, query: book }, searchOk());
    seeds[lib] = {};
    const book1 = s?.results.find((t: any) => t.format.code === "BK") ?? s?.results[0];
    if (book1) seeds[lib].title_id = book1.title_id;
    const ebook = s?.results.flatMap((t: any) => [t, ...t.other_formats]).find((t: any) => t.format.code === "EBOOK");
    if (ebook) seeds[lib].ebook_id = ebook.title_id;
    await F(`F-${++n}`, "search_catalog", { library: lib, query: book, search_type: "title" }, searchOk());
    await F(`F-${++n}`, "search_catalog", { library: lib, query: author, search_type: "author" }, (r) => {
      const p = searchOk()(r) as string[];
      const surname = author.split(",")[0]!.toLowerCase();
      const hit = r.results.filter((t: any) => t.authors.join(" ").toLowerCase().includes(surname)).length;
      if (hit < r.results.length / 2) p.push(`only ${hit}/${r.results.length} results by ${surname}`);
      return p;
    });
    await F(`F-${++n}`, "search_catalog", { library: lib, query: "astronomy", search_type: "subject" }, searchOk());
    await F(`F-${++n}`, "search_catalog", { library: lib, query: "Harry Potter", search_type: "series" }, searchOk());
    const p1 = await F(`F-${++n}`, "search_catalog", { library: lib, query: "history" }, (r) => [...(searchOk(100)(r) as string[]), ...(r.pages < 2 ? ["pages < 2"] : []), ...(![10, 20].includes(r.results.length) ? [`page 1 has ${r.results.length}`] : [])]);
    await F(`F-${++n}`, "search_catalog", { library: lib, query: "history", page: 2 }, (r) => {
      const p = searchOk(100)(r) as string[];
      if (r.page !== 2) p.push(`page field ${r.page}`);
      const first = new Set(p1?.results.map((t: any) => t.title_id));
      const overlap = r.results.filter((t: any) => first.has(t.title_id)).length;
      if (overlap) p.push(`${overlap} titles repeat from page 1`);
      return p;
    });
    await F(`F-${++n}`, "search_catalog", { library: lib, query: "zzqxqxzzyplugh" }, (r) => (r.total === 0 && r.results.length === 0 ? [] : [`expected zero results, got ${r.total}`]));
    // branches
    const b = await F(`F-${++n}`, "list_branches", { library: lib, limit: 200 }, (r) => {
      const p: string[] = [];
      if (r.total < 5) p.push(`only ${r.total} branches`);
      if (r.branches.length !== r.total) p.push("limit 200 did not return all");
      for (const br of r.branches) {
        if (!br.name.trim() || br.name.startsWith("_")) p.push(`bad name "${br.name}"`);
        if (br.today && br.today.open && !hhmm.test(br.today.open)) p.push(`bad open time ${br.today.open}`);
        if (br.open_now === true && br.today && br.today.open === null && br.today.close === null) p.push(`${br.name}: open_now but closed today`);
        if (br.latitude !== null && (Math.abs(br.latitude) > 90 || Math.abs(br.longitude) > 180)) p.push("bad coordinates");
      }
      p.push(`info: ${r.total} branches, ${r.branches.filter((x: any) => x.open_now).length} open now`);
      return p;
    });
    const firstBranch = b?.branches.find((x: any) => x.latitude !== null) ?? b?.branches[0];
    if (firstBranch) seeds[lib].branch = { code: firstBranch.branch_code, name: firstBranch.name };
    await F(`F-${++n}`, "list_branches", { library: lib, open_now: true, limit: 200 }, (r) => (r.branches.every((x: any) => x.open_now === true) ? [`info: ${r.total} open`] : ["a closed branch slipped through open_now"]));
    if (firstBranch) {
      await F(`F-${++n}`, "list_branches", { library: lib, near_latitude: firstBranch.latitude, near_longitude: firstBranch.longitude, limit: 10 }, (r) => {
        const p: string[] = [];
        const d = r.branches.map((x: any) => x.distance_km);
        if (d.some((v: any, i: number) => i > 0 && v !== null && d[i - 1] !== null && v < d[i - 1])) p.push(`not sorted by distance: ${d.join(",")}`);
        if (r.branches[0]?.branch_code !== firstBranch.branch_code) p.push(`nearest is ${r.branches[0]?.name}, expected ${firstBranch.name}`);
        if (d[0] !== 0) p.push(`distance to itself is ${d[0]}`);
        return p;
      });
      await F(`F-${++n}`, "list_branches", { library: lib, name_contains: firstBranch.name.slice(0, 4).toUpperCase() }, (r) => (r.branches.some((x: any) => x.branch_code === firstBranch.branch_code) ? [] : ["name_contains missed the branch"]));
      const full: Check = (r) => {
        const p: string[] = [];
        if (r.branch.branch_code !== firstBranch.branch_code) p.push(`resolved to ${r.branch.name}`);
        if (r.branch.hours.length !== 7) p.push(`${r.branch.hours.length} days of hours`);
        for (const h of r.branch.hours) if ((h.open && !hhmm.test(h.open)) || (h.close && !hhmm.test(h.close))) p.push(`bad hours ${JSON.stringify(h)}`);
        if (!r.branch.timezone) p.push("no timezone");
        return p;
      };
      await F(`F-${++n}`, "get_branch", { library: lib, branch: firstBranch.name }, full);
      await F(`F-${++n}`, "get_branch", { library: lib, branch: firstBranch.branch_code.toLowerCase() }, full);
      await F(`F-${++n}`, "get_branch", { library: lib, branch: `${firstBranch.name} library` }, full);
    }
    // title tools
    const id = seeds[lib].title_id;
    if (id) {
      await F(`F-${++n}`, "get_title", { library: lib, title_id: id }, (r) => {
        const p: string[] = [];
        if (r.title.title_id !== id) p.push("wrong title returned");
        if (!r.title.description) p.push("info: no description");
        if (/<[a-z/][^>]*>|&[a-z]+;/i.test(r.title.description ?? "")) p.push("html in description");
        for (const i of r.title.isbns) if (!/^(\d{9}[\dXx]|\d{13})$/.test(i)) p.push(`odd isbn ${i}`);
        p.push(...availOk(r.title.availability, "title"));
        return p;
      });
      await F(`F-${++n}`, "estimate_wait", { library: lib, title_id: id }, (r) => {
        const p: string[] = [];
        const w = r.estimated_wait_days;
        if (w && !(w.low <= w.likely && w.likely <= w.high)) p.push(`wait range out of order ${JSON.stringify(w)}`);
        if (r.available_now && w && w.likely > 3) p.push("available now but long wait");
        if (!r.basis) p.push("no basis text");
        p.push(`info: available_now=${r.available_now} wait=${JSON.stringify(w)} holds=${r.holds}`);
        return p;
      });
      if (firstBranch) await F(`F-${++n}`, "search_catalog", { library: lib, query: "cooking", available_at_branch: firstBranch.name }, searchOk(0));
    }
    const eb = seeds[lib].ebook_id;
    if (eb) {
      await F(`F-${++n}`, "check_availability", { library: lib, title_id: eb }, (r) => [`info: ebook: ${r.branches.length} branches, summary ${JSON.stringify(r.summary)}`]);
      await F(`F-${++n}`, "estimate_wait", { library: lib, title_id: eb }, (r) => [`info: ebook wait ${JSON.stringify(r.estimated_wait_days)} available_now=${r.available_now}`]);
    }
    // events
    const today = new Date().toISOString().slice(0, 10);
    const plus = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const ev = await F(`F-${++n}`, "list_events", { library: lib }, (r) => {
      const p: string[] = [];
      if (r.total < 1) p.push("no events");
      for (const e of r.events) {
        if (!iso.test(e.start)) p.push(`bad start ${e.start}`);
        if (e.end && e.end < e.start) p.push(`${e.title}: ends before it starts`);
        if (/<[a-z/][^>]*>|&[a-z]+;/i.test(e.description ?? "")) p.push(`html in description of ${e.title}`);
        if (!e.url.startsWith("https://")) p.push("bad url");
        if (e.registration_closed && !e.registration_required) p.push(`${e.title}: closed sign-up on an event with no sign-up`);
      }
      const sorted = r.events.every((e: any, i: number) => i === 0 || r.events[i - 1].start <= e.start);
      if (!sorted) p.push("events not in start order");
      p.push(`info: ${r.total} events, ${r.available_filters.audiences.length} audiences, ${r.available_filters.event_types.length} types`);
      return p;
    });
    await F(`F-${++n}`, "list_events", { library: lib, start_date: plus(7), end_date: plus(9) }, (r) => {
      const out = r.events.filter((e: any) => e.start.slice(0, 10) < plus(7) && (e.end ?? e.start).slice(0, 10) < plus(7) || e.start.slice(0, 10) > plus(9));
      return out.length ? [`${out.length} events outside ${plus(7)}..${plus(9)}: ${out[0].start}`] : [`info: ${r.total} in range`];
    });
    const aud = ev?.available_filters.audiences[0];
    if (aud) await F(`F-${++n}`, "list_events", { library: lib, audience: aud.split(/[ :]/)[0].toLowerCase() }, (r) => (r.total <= ev.total ? [`info: ${r.total} of ${ev.total}`] : ["filter grew the result set"]));
    const typ = ev?.available_filters.event_types.find((t: string) => /book club/i.test(t)) ?? ev?.available_filters.event_types[0];
    if (typ) await F(`F-${++n}`, "list_events", { library: lib, event_type: typ.toLowerCase() }, (r) => {
      const wrong = r.events.filter((e: any) => !e.types.includes(typ));
      return wrong.length ? [`${wrong.length}/${r.events.length} events lack type ${typ}`] : [`info: ${r.total} ${typ}`];
    });
    if (firstBranch) await F(`F-${++n}`, "list_events", { library: lib, branch: firstBranch.name }, (r) => {
      const wrong = r.events.filter((e: any) => e.branch_code !== firstBranch.branch_code && !e.is_online);
      return wrong.length ? [`${wrong.length} events at other branches, e.g. ${wrong[0].branch_name}`] : [`info: ${r.total} at ${firstBranch.name}`];
    });
    await F(`F-${++n}`, "list_events", { library: lib, query: "chess" }, (r) => [`info: ${r.total} chess events`]);
    if (ev && ev.pages > 1) await F(`F-${++n}`, "list_events", { library: lib, page: 2 }, (r) => {
      const first = new Set(ev.events.map((e: any) => `${e.event_id}|${e.start}`));
      const overlap = r.events.filter((e: any) => first.has(`${e.event_id}|${e.start}`)).length;
      return overlap ? [`${overlap} events repeat from page 1`] : [];
    });
    await F(`F-${++n}`, "list_events", { library: lib, start_date: today, end_date: today }, (r) => [`info: ${r.total} today`]);
  }

  // all format aliases on tpl
  for (const f of ["book", "ebook", "audiobook", "eaudiobook", "large_print", "graphic_novel", "picture_book", "dvd", "bluray", "music_cd", "magazine"]) {
    await F(`F-${++n}`, "search_catalog", { library: "tpl", query: f === "magazine" ? "economist" : f === "music_cd" ? "beatles" : f === "picture_book" ? "bear" : f === "graphic_novel" ? "batman" : "star wars", format: f }, (r) => {
      const p = searchOk()(r) as string[];
      const codes = [...new Set(r.results.map((t: any) => t.format.code))];
      p.push(`info: format codes returned: ${codes.join(",")}`);
      return p;
    });
  }
  // awkward but valid input
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "Gabriel García Márquez" }, searchOk());
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "村上春樹" }, searchOk());
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "C++ programming" }, searchOk());
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "100% & ? # = / \\ ;" }, searchOk(0));
  // The site's firewall refuses these; Stacks must say the query is the problem.
  await run("functional", `F-${++n}`, "search_catalog", { library: "tpl", query: '"><script>alert(1)</script>' }, { error: "INVALID_INPUT" });
  await run("functional", `F-${++n}`, "search_catalog", { library: "tpl", query: "' OR 1=1 --" }, { error: "INVALID_INPUT" });
  await run("functional", `F-${++n}`, "search_catalog", { library: "tpl", query: "the ".repeat(120).trim() }, { rejects: true });
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "a long and winding history of the exploration of the polar regions by sea and by air in the nineteenth and twentieth centuries with maps and photographs from the national archives collection" }, searchOk(0));
  await F(`F-${++n}`, "list_events", { library: "tpl", limit: 3 }, (r) => (r.events.length === 3 ? [] : [`limit 3 returned ${r.events.length}`]));
  await run("functional", `F-${++n}`, "search_catalog", { library: "tpl", query: "dune", format: "NOT_A_CODE" }, { error: "INVALID_INPUT" });
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "dune", format: "BK" }, searchOk());
  await F(`F-${++n}`, "search_catalog", { library: "Toronto", query: "dune" }, (r) => (r.library === "tpl" ? [] : [`library resolved to ${r.library}`]));
  await F(`F-${++n}`, "search_catalog", { library: "Vancouver Public Library", query: "dune" }, (r) => (r.library === "vpl" ? [] : [`library resolved to ${r.library}`]));
  await F(`F-${++n}`, "search_catalog", { library: "TPL", query: "dune" }, (r) => (r.library === "tpl" ? [] : [`library resolved to ${r.library}`]));
  await F(`F-${++n}`, "search_catalog", { library: "tpl", query: "dune", page: 50 }, (r) => [`info: page 50 gives ${r.results.length} of ${r.total}, pages=${r.pages}`]);
  await F(`F-${++n}`, "list_events", { library: "tpl", page: 100 }, (r) => [`info: page 100 gives ${r.events.length}, pages=${r.pages}`]);
}

/* ================= ERROR PATHS ================= */
if (groups.has("errors")) {
  const E = (id: string, tool: string, args: Record<string, unknown>, error: string | string[]) => run("errors", id, tool, args, { error });
  await E("E-01", "search_catalog", { library: "zzznotalibraryzzz", query: "dune" }, "UNKNOWN_LIBRARY");
  await E("E-02", "search_catalog", { library: "bad id!", query: "dune" }, "UNKNOWN_LIBRARY");
  await E("E-03", "list_branches", { library: "zzznotalibraryzzz" }, "UNKNOWN_LIBRARY");
  await E("E-04", "list_events", { library: "zzznotalibraryzzz" }, "UNKNOWN_LIBRARY");
  await E("E-05", "get_title", { library: "tpl", title_id: "S234C9999999" }, "NOT_FOUND");
  await E("E-06", "check_availability", { library: "tpl", title_id: "S234C9999999" }, "NOT_FOUND");
  await E("E-07", "estimate_wait", { library: "tpl", title_id: "S234C9999999" }, "NOT_FOUND");
  await E("E-08", "get_branch", { library: "tpl", branch: "Hogwarts" }, "NOT_FOUND");
  await E("E-09", "check_availability", { library: "tpl", title_id: "S234C3970025", branch: "Hogwarts" }, "NOT_FOUND");
  await E("E-10", "search_catalog", { library: "tpl", query: "dune", available_at_branch: "Hogwarts" }, ["NOT_FOUND", "INVALID_INPUT"]);
  await E("E-11", "list_events", { library: "tpl", branch: "Hogwarts" }, ["NOT_FOUND", "INVALID_INPUT"]);
  await E("E-12", "list_events", { library: "tpl", audience: "martians" }, "INVALID_INPUT");
  await E("E-13", "list_events", { library: "tpl", event_type: "jousting" }, "INVALID_INPUT");
  await E("E-14", "list_events", { library: "seattle" }, "NOT_SUPPORTED");
  await E("E-15", "list_branches", { library: "seattle" }, "NOT_SUPPORTED");
  await E("E-16", "search_catalog", { library: "nypl", query: "dune" }, ["SITE_BLOCKED", "UNKNOWN_LIBRARY"]);
  await E("E-17", "get_job_result", { job_id: "ask.00000000-0000-4000-8000-000000000000" }, "NOT_FOUND");
  await E("E-18", "cancel_watch", { watch_id: "00000000-0000-4000-8000-000000000000" }, "NOT_FOUND");
  await E("E-19", "cancel_watch", { watch_id: "not-a-uuid" }, ["NOT_FOUND", "INVALID_INPUT"]);
  // An id from another library is redirected by the site to this library's own record.
  await run("errors", "E-20", "get_title", { library: "vpl", title_id: "S234C3970025" }, { check: (r) => (/^S38C\d+$/.test(r.title.title_id) ? [`info: resolved to ${r.title.title_id}`] : [`resolved to ${r.title.title_id}`]) });
  await E("E-21", "health_check", { library: "zzznotalibraryzzz" }, "UNKNOWN_LIBRARY");
  await E("E-22", "watch_title", { library: "tpl", title_id: "S234C9999999" }, "NOT_FOUND");
}

/* ================= DATA INVARIANTS ================= */
if (groups.has("invariants")) {
  for (const [i, lib, q] of [[1, "tpl", "Project Hail Mary"], [2, "vpl", "Dune"], [3, "chipublib", "The Great Gatsby"], [4, "tpl", "Braiding Sweetgrass"], [5, "sfpl", "Beloved"]] as const) {
    const s = await run("invariants", `I-${i}a`, "search_catalog", { library: lib, query: q, format: "book" }, { check: searchOk() });
    const t = s?.results[0];
    if (!t) continue;
    await run("invariants", `I-${i}b`, "check_availability", { library: lib, title_id: t.title_id, limit: 150 }, {
      check: (r) => {
        const p: string[] = [];
        const onShelf = r.branches.filter((b: any) => b.copies_on_shelf > 0).length;
        const copies = r.branches.reduce((n: number, b: any) => n + b.copies_total, 0);
        const shelfCopies = r.branches.reduce((n: number, b: any) => n + b.copies_on_shelf, 0);
        if (!r.truncated && r.branches.length !== r.branches_holding) p.push(`branches ${r.branches.length} != branches_holding ${r.branches_holding}`);
        if (!r.truncated && onShelf !== r.branches_on_shelf) p.push(`branches_on_shelf ${r.branches_on_shelf} but ${onShelf} branches list a shelf copy`);
        for (const b of r.branches) {
          if (b.copies.length !== b.copies_total) p.push(`${b.branch_name}: copies_total ${b.copies_total} vs ${b.copies.length} listed`);
          const shelf = b.copies.filter((c: any) => c.status === "on_shelf").length;
          if (shelf !== b.copies_on_shelf) p.push(`${b.branch_name}: copies_on_shelf ${b.copies_on_shelf} vs ${shelf} with status on_shelf`);
          if (b.branch_name.startsWith("_")) p.push(`raw branch name ${b.branch_name}`);
        }
        const firstEmpty = r.branches.findIndex((b: any) => b.copies_on_shelf === 0);
        if (firstEmpty >= 0 && r.branches.slice(firstEmpty).some((b: any) => b.copies_on_shelf > 0)) p.push("on-shelf branches are not listed first");
        const statuses: Record<string, number> = {};
        for (const b of r.branches) for (const c of b.copies) statuses[`${c.status}/${c.status_label}`] = (statuses[`${c.status}/${c.status_label}`] ?? 0) + 1;
        if (!r.truncated && r.summary.total_copies !== null && Math.abs(copies - r.summary.total_copies) > Math.max(2, r.summary.total_copies * 0.05)) p.push(`copies listed ${copies} vs summary total ${r.summary.total_copies}`);
        if (r.summary.status === "available" && shelfCopies === 0 && !r.truncated) p.push("summary says available but no copy is on a shelf");
        const unmapped = Object.entries(statuses).filter(([k]) => /^unavailable\/(checked out|on loan|in transit)/i.test(k));
        if (unmapped.length) p.push(`copy wording not mapped: ${unmapped.map(([k]) => k).join(", ")}`);
        if (!r.truncated && r.summary.available_copies !== shelfCopies) p.push(`info: summary says ${r.summary.available_copies} available, ${shelfCopies} copies have status on_shelf`);
        p.push(`info: ${r.branches_holding} branches, ${copies} copies, statuses ${JSON.stringify(statuses)}`);
        return p;
      },
    });
    await run("invariants", `I-${i}c`, "check_availability", { library: lib, title_id: t.title_id, on_shelf_only: true, limit: 150 }, {
      check: (r) => (r.branches.every((b: any) => b.copies_on_shelf > 0) ? [`info: ${r.branches.length} on-shelf branches`] : ["on_shelf_only returned a branch with no shelf copy"]),
    });
    const w7 = await run("invariants", `I-${i}d`, "estimate_wait", { library: lib, title_id: t.title_id, loan_days: 7 });
    await run("invariants", `I-${i}e`, "estimate_wait", { library: lib, title_id: t.title_id, loan_days: 42 }, {
      check: (r) => {
        const a = w7?.estimated_wait_days?.likely, b = r.estimated_wait_days?.likely;
        if (a === undefined || b === undefined || a === null || b === null) return [`info: no estimate (7d=${JSON.stringify(w7?.estimated_wait_days)}, 42d=${JSON.stringify(r.estimated_wait_days)})`];
        return b < a ? [`longer loans gave a shorter wait: ${a} -> ${b}`] : [`info: 7-day loans ${a} days, 42-day loans ${b} days`];
      },
    });
  }
}

/* ================= CACHE ================= */
if (groups.has("cache")) {
  const args = { library: "chipublib", query: "cache probe beloved" };
  const cold = await raw("search_catalog", args);
  const warm = await raw("search_catalog", args);
  record("cache", "C-01", "repeat search is served from cache", warm.ok && warm.data.source.cached === true && warm.ms < 200, `cold ${cold.ms} ms, warm ${warm.ms} ms, cached=${warm.data?.source?.cached}`, warm.ms);
  record("cache", "C-02", "cached result equals live result", JSON.stringify(cold.data?.results) === JSON.stringify(warm.data?.results), "result arrays identical");
  record("cache", "C-03", "cached result keeps the original retrieved_at", cold.data?.source.retrieved_at === warm.data?.source.retrieved_at, `${cold.data?.source.retrieved_at} vs ${warm.data?.source.retrieved_at}`);
  const b1 = await raw("list_branches", { library: "chipublib" });
  const b2 = await raw("get_branch", { library: "chipublib", branch: b1.data?.branches[0]?.name ?? "x" });
  record("cache", "C-04", "get_branch reuses the cached branch list", b2.ok && b2.data.source.cached === true, `list ${b1.ms} ms, get ${b2.ms} ms`, b2.ms);
  const bad1 = await raw("get_title", { library: "tpl", title_id: "S234C9999998" });
  const bad2 = await raw("get_title", { library: "tpl", title_id: "S234C9999998" });
  record("cache", "C-05", "errors are not cached as successes", !bad1.ok && !bad2.ok && bad1.code === bad2.code, `${bad1.code} then ${bad2.code} (${bad1.ms} ms, ${bad2.ms} ms)`);
}

/* ================= CONCURRENCY ================= */
if (groups.has("concurrency")) {
  let t0 = Date.now();
  const same = await Promise.all(Array.from({ length: 5 }, () => raw("search_catalog", { library: "vpl", query: "concurrency probe tolkien" })));
  record("concurrency", "K-01", "5 identical calls at once all succeed with one web read", same.every((r) => r.ok) && new Set(same.map((r) => JSON.stringify(r.data?.results))).size === 1, `wall ${Date.now() - t0} ms; per call ${same.map((r) => r.ms).join(", ")} ms; codes ${same.map((r) => r.code || "ok").join(",")}`, Date.now() - t0);
  t0 = Date.now();
  const mixed = await Promise.all([
    raw("search_catalog", { library: "tpl", query: "parallel one" }),
    raw("search_catalog", { library: "vpl", query: "parallel two" }),
    raw("search_catalog", { library: "chipublib", query: "parallel three" }),
    raw("list_branches", { library: "sfpl" }),
    raw("list_events", { library: "bpl" }),
    raw("search_catalog", { library: "ottawa", query: "parallel six" }),
    raw("search_catalog", { library: "calgary", query: "parallel seven" }),
    raw("list_branches", { library: "kcls" }),
  ]);
  record("concurrency", "K-02", "8 different calls at once across 8 libraries", mixed.every((r) => r.ok), `wall ${Date.now() - t0} ms; per call ${mixed.map((r) => `${r.code || "ok"}:${r.ms}`).join(", ")}`, Date.now() - t0);
  t0 = Date.now();
  const sameHost = await Promise.all(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((q) => raw("search_catalog", { library: "tpl", query: `${q} centauri` })));
  record("concurrency", "K-03", "6 different searches at once on one library (rate limiter spaces them)", sameHost.every((r) => r.ok), `wall ${Date.now() - t0} ms; per call ${sameHost.map((r) => `${r.code || "ok"}:${r.ms}`).join(", ")}`, Date.now() - t0);
}

/* ================= RELIABILITY (repeatability) ================= */
if (groups.has("reliability")) {
  for (const lib of ["vpl", "tpl", "chipublib"]) {
    const qs = ["harry potter", "pride and prejudice", "gardening", "python", "atlas", "jazz", "tolkien", "volcano", "knitting", "mars"];
    const out: Array<{ q: string; code: string; ms: number }> = [];
    for (const q of qs) {
      const r = await raw("search_catalog", { library: lib, query: q });
      out.push({ q, code: r.ok ? "ok" : `${r.code} (${r.text.replace(/\s+/g, " ").slice(0, 200)})`, ms: r.ms });
    }
    const fails = out.filter((o) => o.code !== "ok");
    const ms = out.filter((o) => o.code === "ok").map((o) => o.ms).sort((a, b) => a - b);
    record("reliability", `R-${lib}`, `10 consecutive uncached searches on ${lib}`, fails.length === 0, `${10 - fails.length}/10 ok; failures: ${fails.map((f) => `${f.q}=${f.code}`).join(", ") || "none"}; ms min ${ms[0]} median ${ms[Math.floor(ms.length / 2)]} max ${ms[ms.length - 1]}`);
  }
}

/* ================= REGISTRY SWEEP ================= */
if (groups.has("sweep")) {
  const reg = JSON.parse(readFileSync("src/adapters/bibliocommons/registry.json", "utf8")) as Array<{ id: string }>;
  const queue = [...reg.map((r) => r.id)];
  const sweep: Array<{ lib: string; code: string; total: number; ms: number; note: string }> = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let lib = queue.shift(); lib; lib = queue.shift()) {
      let r = await raw("search_catalog", { library: lib, query: "harry potter" });
      let note = "";
      if (!r.ok) {
        note = `first try ${r.code}; `;
        r = await raw("search_catalog", { library: lib, query: "harry potter" });
        note += r.ok ? "retry ok" : `retry ${r.code}`;
      }
      sweep.push({ lib, code: r.ok ? "ok" : r.code, total: r.data?.total ?? 0, ms: r.ms, note });
    }
  }));
  sweep.sort((a, b) => a.lib.localeCompare(b.lib));
  for (const s of sweep) {
    results.push({ id: `S-${s.lib}`, group: "sweep", tool: "search_catalog", args: { library: s.lib, query: "harry potter" }, expect: "success with results", outcome: s.code === "ok" && s.total > 0 ? "pass" : "fail", got: s.code, ms: s.ms, note: `${s.total} results. ${s.note}` });
    console.log(`${s.code === "ok" && s.total > 0 ? "pass" : "FAIL"} S-${s.lib.padEnd(18)} ${s.code} total=${s.total} ${s.ms}ms ${s.note}`);
  }
}

/* ================= WATCH (TinyFish Monitor) ================= */
if (groups.has("watch")) {
  const before = await run("watch", "W-01", "list_watches", {}, { check: (r) => [`info: ${r.watches.length} existing`] });
  const seed = await raw("search_catalog", { library: "vpl", query: "Dune", format: "book" });
  const w = await run("watch", "W-02", "watch_title", { library: "vpl", title_id: opt("--watch-title") ?? seed.data?.results[0]?.title_id ?? "", check_every: "day" }, { check: (r) => (r.watch.status === "active" && r.watch.library === "vpl" ? [`info: ${r.watch.watch_id} cron ${r.watch.schedule_cron}`] : ["watch not active"]) });
  if (w) {
    const id = w.watch.watch_id;
    await run("watch", "W-03", "list_watches", {}, { check: (r) => (r.watches.some((x: any) => x.watch_id === id) ? [] : ["new watch not listed"]) });
    await run("watch", "W-04", "list_watches", { check_now: true }, { check: (r) => (r.watches.find((x: any) => x.watch_id === id)?.current ? [] : ["check_now returned no current availability"]) });
    const dup = await run("watch", "W-05", "watch_title", { library: "vpl", title_id: w.watch.title_id, check_every: "day" }, { check: (r) => (r.watch.watch_id === id && r.already_existed ? ["info: duplicate request returned the existing watch"] : [`duplicate request created a second watch ${r.watch.watch_id}`]) });
    await run("watch", "W-06", "cancel_watch", { watch_id: id });
    if (dup && dup.watch.watch_id !== id) await run("watch", "W-06b", "cancel_watch", { watch_id: dup.watch.watch_id });
    await run("watch", "W-07", "cancel_watch", { watch_id: id }, { error: "NOT_FOUND" });
    await run("watch", "W-08", "list_watches", {}, { check: (r) => (r.watches.length === before?.watches.length ? [] : [`${r.watches.length} watches left, started with ${before?.watches.length}`]) });
  }
}

/* ================= AGENT ================= */
if (groups.has("agent")) {
  const poll = async (id: string, label: string, jobId: string, check: Check) => {
    const t0 = Date.now();
    for (;;) {
      const r = await raw("get_job_result", { job_id: jobId });
      if (!r.ok) return record("agent", id, label, false, `${r.code}: ${r.text.slice(0, 200)}`, Date.now() - t0);
      if (r.data.status !== "running") {
        const problems = ([] as string[]).concat((check(r.data) as string[]) ?? []);
        return record("agent", id, label, r.data.status === "completed" && !problems.some((p) => !p.startsWith("info:")), `${r.data.status} after ${Date.now() - t0} ms of polling; ${problems.join("; ")}`, Date.now() - t0);
      }
      if (Date.now() - t0 > 240_000) return record("agent", id, label, false, "still running after 4 minutes", Date.now() - t0);
      await new Promise((res) => setTimeout(res, 15_000));
    }
  };
  const questions: Array<[string, string, string, RegExp | null]> = [
    ["A-01", "tpl", "What are the overdue fines for adult books?", /fine|no (late|overdue)/i],
    ["A-02", "chipublib", "How do I get a library card if I live outside Chicago?", /card|resident|fee/i],
    ["A-03", "vpl", "What is the airspeed velocity of an unladen swallow?", null],
  ];
  for (const [id, lib, q, expectRe] of questions) {
    const r = await run("agent", id, "ask_library", { library: lib, question: q }, {
      check: (d) => {
        const p: string[] = [];
        if (!["completed", "running"].includes(d.status)) p.push(`status ${d.status}`);
        if (d.status === "completed") {
          if (expectRe && !expectRe.test(d.answer ?? "")) p.push("answer off topic");
          if (expectRe && !d.source_urls.length) p.push("no source urls");
          if (!expectRe && d.found !== false) p.push(`info: off-topic question answered with found=${d.found}`);
          p.push(`info: found=${d.found}; answer: ${(d.answer ?? "").slice(0, 220)}; sources: ${d.source_urls.slice(0, 2).join(", ")}`);
        } else p.push(`info: still running after the wait window, job ${d.job_id}`);
        return p;
      },
    });
    if (r?.status === "running") await poll(`${id}p`, `get_job_result finishes ${id}`, r.job_id, (d) => [`info: ${JSON.stringify(d.result).slice(0, 300)}`]);
  }
}

/* ================= HEALTH ================= */
if (groups.has("health")) {
  for (const lib of ["tpl", "vpl", "chipublib", "sfpl", "seattle"]) {
    await run("health", `H-${lib}`, "health_check", { library: lib }, {
      check: (r) => {
        const p: string[] = [];
        const fails = r.checks.filter((c: any) => c.status === "fail");
        if (r.healthy !== (fails.length === 0)) p.push("healthy flag disagrees with the checks");
        if (lib !== "seattle" && fails.length) p.push(`failed: ${fails.map((c: any) => `${c.name} [${c.error_code}] ${c.broken_fields.join("|")}`).join("; ")}`);
        const engines = new Set(r.checks.map((c: any) => c.engine));
        p.push(`info: ${r.summary} engines ${[...engines].join(",")} calls ${JSON.stringify(r.tinyfish_calls)}`);
        return p;
      },
    });
  }
}

/* ---------- wrap up ---------- */
const privacy = { staff_keys_in_output: staffKeyHits, email_fields: Object.fromEntries([...emails].map(([k, v]) => [k, [...v].slice(0, 6)])) };
const pass = results.filter((r) => r.outcome === "pass").length;
console.log(`\n${pass}/${results.length} passed; ${results.length - pass} failed`);
console.log(`privacy scan: staff keys ${staffKeyHits}; emails in fields: ${JSON.stringify(privacy.email_fields)}`);
if (outFile) writeFileSync(outFile, JSON.stringify({ ran_at: new Date().toISOString(), groups: [...groups], results, privacy }, null, 2));
await client.close();
process.exit(0);
