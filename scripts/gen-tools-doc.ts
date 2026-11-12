/** Generate docs/TOOLS.md from the tool definitions, so the reference never drifts from the code. */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { TOOLS } from "../src/tools/index.js";

type Prop = { type?: string; enum?: string[]; default?: unknown; description?: string; anyOf?: Prop[]; items?: Prop };
const typeOf = (p: Prop): string =>
  p.enum ? p.enum.map((e) => `"${e}"`).join(" \\| ") : p.anyOf ? p.anyOf.map(typeOf).join(" \\| ") : p.type === "array" ? `${typeOf(p.items ?? {})}[]` : (p.type ?? "object");

let md = "# Tool reference\n\nGenerated from the tool definitions by `npm run docs`. Do not edit by hand.\n\nEvery tool returns `structuredContent` matching its output schema, and a `source` object saying which TinyFish endpoints produced the data, from which URL, and when.\n";
for (const t of TOOLS) {
  const input = z.toJSONSchema(z.object(t.input)) as { properties: Record<string, Prop>; required?: string[] };
  const output = z.toJSONSchema(z.object(t.output)) as { properties: Record<string, Prop> };
  md += `\n## \`${t.name}\`\n\n${t.description}\n\n**Input**\n\n| Field | Type | Required | Description |\n|---|---|---|---|\n`;
  for (const [k, p] of Object.entries(input.properties)) {
    const req = input.required?.includes(k) && p.default === undefined ? "yes" : p.default !== undefined ? `default \`${JSON.stringify(p.default)}\`` : "no";
    md += `| \`${k}\` | ${typeOf(p)} | ${req} | ${(p.description ?? "").replace(/\|/g, "\\|")} |\n`;
  }
  md += `\n**Output**\n\n| Field | Type | Description |\n|---|---|---|\n`;
  for (const [k, p] of Object.entries(output.properties)) md += `| \`${k}\` | ${typeOf(p)} | ${(p.description ?? "").replace(/\|/g, "\\|")} |\n`;
}
writeFileSync(new URL("../docs/TOOLS.md", import.meta.url), md);
console.log(`Wrote docs/TOOLS.md (${TOOLS.length} tools)`);
