import { describe, expect, it } from "vitest";
import { registrySearch, REGISTRY } from "../src/adapters/bibliocommons/registry.js";
import { TtlCache } from "../src/core/cache.js";
import { agentSchema, jobId, parseJobId } from "../src/core/jobs.js";
import { cleanText, matchLabel } from "../src/core/text.js";
import { TOOLS } from "../src/tools/index.js";
import { z } from "zod";

describe("tool design", () => {
  it("every tool has a snake_case name, a description and typed input and output", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(3);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(t.description.length).toBeGreaterThan(40);
      expect(() => z.toJSONSchema(z.object(t.input))).not.toThrow();
      expect(Object.keys(t.output).length).toBeGreaterThan(0);
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });
});

describe("library directory", () => {
  it("finds libraries by city, name or id", () => {
    expect(registrySearch("Toronto")[0]?.id).toBe("tpl");
    expect(registrySearch("vancouver public library")[0]?.id).toBe("vpl");
    expect(registrySearch("chipublib")[0]?.id).toBe("chipublib");
    expect(registrySearch("Atlantis")).toEqual([]);
  });
  it("has unique, well-formed entries", () => {
    expect(new Set(REGISTRY.map((r) => r.id)).size).toBe(REGISTRY.length);
    for (const r of REGISTRY) expect(r.id).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("text helpers", () => {
  it("cleans double-escaped HTML", () => {
    expect(cleanText("&lt;p&gt;Drop-in.&nbsp;No registration &amp;amp; free.&lt;/p&gt;")).toBe("Drop-in. No registration & free.");
  });
  it("matches branch names loosely across tools", () => {
    const branches = [{ n: "Central Library" }, { n: "Champlain Heights Branch" }, { n: "Kitsilano Branch" }];
    expect(matchLabel("_Central Branch", branches, (b) => [b.n])?.n).toBe("Central Library");
    expect(matchLabel("Champlain Heights Branch Library", branches, (b) => [b.n])?.n).toBe("Champlain Heights Branch");
    expect(matchLabel("kits", branches, (b) => [b.n])?.n).toBe("Kitsilano Branch");
    expect(matchLabel("Narnia", branches, (b) => [b.n])).toBeUndefined();
  });
});

describe("jobs and cache", () => {
  it("round-trips job ids and rejects junk", () => {
    const id = jobId("ask", "96e4d306-7512-42eb-bfca-0b30ac85c260");
    expect(parseJobId(id)).toEqual({ kind: "ask", runId: "96e4d306-7512-42eb-bfca-0b30ac85c260" });
    expect(() => parseJobId("nope")).toThrowError(/not a valid job_id/);
  });
  it("emits only the JSON Schema subset TinyFish accepts", () => {
    const s = JSON.stringify(agentSchema(z.object({ a: z.string().describe("x"), b: z.array(z.string()) })));
    expect(s).not.toMatch(/\$schema|additionalProperties|"description":"x"/);
  });
  it("computes once under concurrent callers", async () => {
    const cache = new TtlCache();
    let calls = 0;
    const get = () => cache.wrap("k", 1000, async () => ++calls);
    const [a, b] = await Promise.all([get(), get()]);
    expect([a.value, b.value, calls]).toEqual([1, 1, 1]);
    expect((await get()).cached).toBe(true);
  });
});
