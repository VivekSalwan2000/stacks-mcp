/**
 * Rebuild the library directory.
 *
 * Reads candidate library ids from scripts/registry-candidates.json, checks
 * each catalogue live with TinyFish Fetch, and writes only the ones that
 * respond as BiblioCommons catalogues to src/adapters/bibliocommons/registry.json.
 *
 *   npm run refresh-registry
 *
 * To add a library: add a line to registry-candidates.json and run this.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { TinyFish } from "@tiny-fish/sdk";

interface Candidate {
  id: string;
  city: string | null;
  region: string | null;
  country: string | null;
}

const here = new URL(".", import.meta.url);
const candidates: Candidate[] = JSON.parse(readFileSync(new URL("registry-candidates.json", here), "utf8"));
const client = new TinyFish();
const verified: Array<Candidate & { name: string }> = [];
const rejected: string[] = [];

for (let i = 0; i < candidates.length; i += 10) {
  const batch = candidates.slice(i, i + 10);
  const urls = batch.map((c) => `https://${c.id}.bibliocommons.com/v2/search?query=library&searchType=smart`);
  const res = await client.fetch.getContents({ urls, format: "markdown" });
  for (const c of batch) {
    const page = res.results.find((r) => new URL(r.url).host === `${c.id}.bibliocommons.com`);
    const finalHost = page?.final_url ? new URL(page.final_url).host : null;
    const name = page?.title?.match(/^Search\s+[—–-]\s+(.+?)\s*$/)?.[1] ?? page?.title?.match(/\|\s*([^|]+?)\s*\|\s*BiblioCommons\s*$/)?.[1];
    if (page && name && finalHost === `${c.id}.bibliocommons.com`) verified.push({ ...c, name });
    else rejected.push(`${c.id} (${page?.title ?? "no response"})`);
  }
  process.stderr.write(`checked ${Math.min(i + 10, candidates.length)}/${candidates.length}\n`);
}

verified.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(new URL("../src/adapters/bibliocommons/registry.json", here), `${JSON.stringify(verified, null, 2)}\n`);
console.log(`Verified ${verified.length} libraries. Rejected ${rejected.length}:`);
for (const r of rejected) console.log(`  - ${r}`);
