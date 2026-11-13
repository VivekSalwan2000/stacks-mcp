/**
 * End-to-end smoke test against live library websites, through the real MCP
 * protocol (an in-memory client talking to the Stacks server).
 *
 *   npm run e2e              # core tools on three libraries
 *   npm run e2e -- --all     # also the slow Agent tool and a Monitor round trip
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { buildServer, createContext, loadConfig } from "../src/server.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const all = process.argv.includes("--all");
const ctx = createContext(loadConfig());
const server = buildServer(() => ctx);
const client = new Client({ name: "stacks-e2e", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

let failures = 0;
async function call(name: string, args: Record<string, unknown>, show: (r: any) => string, expectError?: string): Promise<any> {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const ms = Date.now() - t0;
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  if (res.isError) {
    const code = JSON.parse(text).error?.code;
    const ok = expectError === code;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}(${JSON.stringify(args)})  ${ms} ms\n       ${ok ? `expected error ${code}` : text.slice(0, 400)}`);
    return null;
  }
  if (expectError) {
    failures++;
    console.log(`FAIL ${name}: expected error ${expectError} but succeeded`);
    return res.structuredContent;
  }
  console.log(`ok   ${name}(${JSON.stringify(args)})  ${ms} ms${res.structuredContent && (res.structuredContent as any).source?.cached ? " (cached)" : ""}\n       ${show(res.structuredContent)}`);
  return res.structuredContent;
}

const tools = await client.listTools();
console.log(`${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);
console.log(`all have output schemas: ${tools.tools.every((t) => t.outputSchema)}\n`);

const today = new Date().toISOString().slice(0, 10);
const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

for (const [city, book] of [["Toronto", "Project Hail Mary"], ["Vancouver", "Dune"], ["Chicago", "The Great Gatsby"]] as const) {
  console.log(`--- ${city} ---`);
  const found = await call("find_library", { query: city }, (r) => r.matches.map((m: any) => `${m.library_id} = ${m.name} (verified ${m.verified})`).join("; "));
  const library = found?.matches[0]?.library_id;
  if (!library) continue;
  const search = await call("search_catalog", { library, query: book, format: "book" }, (r) => `${r.total} results; ${r.results.slice(0, 3).map((t: any) => `"${t.title}" ${t.format.label} ${t.year} [${t.availability.status}, ${t.availability.holds} holds/${t.availability.total_copies} copies]`).join(" | ")}`);
  const title_id = search?.results[0]?.title_id;
  if (title_id) {
    const avail = await call("check_availability", { library, title_id, limit: 3 }, (r) => `"${r.title}": on shelf at ${r.branches_on_shelf}/${r.branches_holding} branches; ${r.branches.map((b: any) => `${b.branch_name} ${b.copies_on_shelf}/${b.copies_total}`).join(", ")}`);
    await call("estimate_wait", { library, title_id }, (r) => `available_now=${r.available_now} wait=${JSON.stringify(r.estimated_wait_days)} alternatives=${r.faster_alternatives.length} :: ${r.basis}`);
    await call("get_title", { library, title_id }, (r) => `${r.title.publisher} | ISBNs ${r.title.isbns.slice(0, 2)} | ${r.title.description?.slice(0, 90)}…`);
    const branch = avail?.branches[0]?.branch_name;
    if (branch) {
      await call("get_branch", { library, branch }, (r) => `${r.branch.name}: open_now=${r.branch.open_now} today=${r.branch.today.open}-${r.branch.today.close}; ${r.branch.services.length} services (${r.branch.services.slice(0, 4).join(", ")})`);
      await call("list_events", { library, branch, start_date: today, end_date: inAWeek }, (r) => `${r.total} events; ${r.events.slice(0, 2).map((e: any) => `${e.start} "${e.title}" [${e.audiences.join("/")}]`).join(" | ")}`);
    }
  }
  await call("list_branches", { library, open_now: true, limit: 3 }, (r) => `${r.total} open now; ${r.branches.map((b: any) => `${b.name} until ${b.today.close}`).join(", ")}`);
}

console.log("--- errors are loud and typed ---");
await call("search_catalog", { library: "tpl", query: "zzqxqxzzy" }, (r) => `${r.total} results (did_you_mean: ${r.did_you_mean})`);
await call("check_availability", { library: "tpl", title_id: "S234C0000001" }, () => "", "NOT_FOUND");
await call("check_availability", { library: "tpl", title_id: "nonsense" }, () => "", "INVALID_INPUT");
await call("search_catalog", { library: "no-such-library-xyz", query: "dune" }, () => "", "UNKNOWN_LIBRARY");
await call("list_events", { library: "tpl", audience: "martians" }, () => "", "INVALID_INPUT");
await call("list_branches", { library: "seattle" }, () => "", "NOT_SUPPORTED");
await call("find_library", { query: "Ottawa" }, (r) => r.matches.map((m: any) => `${m.library_id} = ${m.name}`).join("; "));

if (all) {
  console.log("--- agent + monitor ---");
  const ask = await call("ask_library", { library: "tpl", question: "Does the Yorkville branch have a meeting room I can book?" }, (r) => `status=${r.status} found=${r.found} job=${r.job_id}\n       ${r.answer}\n       sources: ${r.source_urls.join(", ")}`);
  if (ask?.job_id) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const job = await call("get_job_result", { job_id: ask.job_id }, (r) => `status=${r.status} ${JSON.stringify(r.result)?.slice(0, 300)}`);
      if (job?.status !== "running") break;
    }
  }
  const watch = await call("watch_title", { library: "tpl", title_id: "S234C3970025", check_every: "day" }, (r) => `watch ${r.watch.watch_id} ${r.watch.status} ${r.watch.schedule_cron}; now ${JSON.stringify(r.availability_at_creation)}`);
  await call("list_watches", { check_now: true }, (r) => r.watches.map((w: any) => `${w.watch_id} ${w.library}/${w.title_id} "${w.title}" ${w.status} current=${w.current?.status}`).join("; "));
  if (watch) await call("cancel_watch", { watch_id: watch.watch.watch_id }, (r) => `cancelled=${r.cancelled}`);
}

console.log(`\nTinyFish calls: ${JSON.stringify(ctx.web.usage)}`);
console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED");
await ctx.web.close();
process.exit(failures ? 1 : 0);
