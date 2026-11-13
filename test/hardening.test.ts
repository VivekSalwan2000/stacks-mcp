/**
 * Guards added in 0.1.3 after a full audit: an exposed server key, a session
 * address in an error, failures that were hidden, a page that was not the page
 * asked for, too many pages at once, and the per-call log line.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { Semaphore } from "../src/core/cache.js";
import { loadConfig } from "../src/core/config.js";
import { createContext } from "../src/core/context.js";
import { redact, StacksError, toStacksError } from "../src/core/errors.js";
import { hostOf } from "../src/core/text.js";
import type { CallLog } from "../src/core/tool.js";
import { MAX_CONCURRENT_PAGES } from "../src/core/web.js";
import { startHttp } from "../src/http.js";
import { buildServer } from "../src/server.js";
import { TOOLS } from "../src/tools/index.js";
import { fixture, FakeWeb, TEST_CONFIG } from "./helpers.js";

function setup(config = TEST_CONFIG) {
  const web = new FakeWeb();
  const ctx = createContext(config, web);
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
  throw new Error("expected a failure, but the call returned");
}

describe("HTTP mode never serves the server's key to the open network", () => {
  const servers: Array<ReturnType<typeof startHttp>> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("refuses to start on a public address with a server key and no token", () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20"]) {
      let thrown: unknown;
      try {
        servers.push(startHttp({ ...TEST_CONFIG, apiKey: "server-key", port: 0 }, { HOST }));
      } catch (err) {
        thrown = err;
      }
      expect(thrown, HOST).toBeInstanceOf(StacksError);
      expect((thrown as StacksError).code).toBe("CONFIG_ERROR");
      expect((thrown as StacksError).hint).toContain("STACKS_HTTP_TOKEN");
      expect(JSON.stringify((thrown as StacksError).toJSON())).not.toContain("server-key");
    }
  });

  it("starts on a public address once a token is set, or when callers bring their own key", async () => {
    const withToken = startHttp({ ...TEST_CONFIG, apiKey: "server-key", port: 0 }, { HOST: "0.0.0.0", STACKS_HTTP_TOKEN: "t" });
    const byoKey = startHttp({ ...TEST_CONFIG, apiKey: "", port: 0 }, { HOST: "0.0.0.0" });
    servers.push(withToken, byoKey);
    await Promise.all([once(withToken, "listening"), once(byoKey, "listening")]);
  });

  it("/healthz reports status and uptime without a token and without touching TinyFish", async () => {
    const server = startHttp({ ...TEST_CONFIG, apiKey: "server-key", port: 0 }, { HOST: "127.0.0.1", STACKS_HTTP_TOKEN: "t" });
    servers.push(server);
    await once(server, "listening");
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", name: "stacks-mcp" });
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(body)).not.toMatch(/server-key|"t"/);
  });
});

describe("errors carry no session address", () => {
  it("redacts a remote browser address from a connection failure", () => {
    const err = toStacksError(new Error("browserType.connectOverCDP: WebSocket error: wss://browser.example/session/abc123?token=s3cret 403 Forbidden"));
    const text = JSON.stringify(err.toJSON());
    expect(text).not.toMatch(/wss:|abc123|s3cret/);
    expect(text).toContain("403 Forbidden");
    expect(redact("see ws://10.0.0.1:9222/devtools/x and https://tpl.ca/page")).toBe("see [remote browser address] and https://tpl.ca/page");
  });
});

describe("settings are checked at start-up", () => {
  it("rejects a port or wait time that is not a sensible number", () => {
    expect(() => loadConfig({ TINYFISH_API_KEY: "k", PORT: "eighty" })).toThrow(/PORT/);
    expect(() => loadConfig({ TINYFISH_API_KEY: "k", PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ TINYFISH_API_KEY: "k", STACKS_AGENT_WAIT_MS: "-5" })).toThrow(/STACKS_AGENT_WAIT_MS/);
    expect(loadConfig({ TINYFISH_API_KEY: "k", PORT: " 8080 ", STACKS_AGENT_WAIT_MS: "0" })).toMatchObject({ port: 8080, agentWaitMs: 0 });
  });
  it("logging is on unless STACKS_LOG turns it off", () => {
    expect(loadConfig({ TINYFISH_API_KEY: "k" }).log).toBe(true);
    expect(loadConfig({ TINYFISH_API_KEY: "k", STACKS_LOG: "off" }).log).toBe(false);
    expect(loadConfig({ TINYFISH_API_KEY: "k", STACKS_LOG: "0" }).log).toBe(false);
  });
});

describe("answers that used to be quietly wrong", () => {
  it("search_catalog: a page past the last one is an error, not page 1 again", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/search", fixture("search")); // the site answers any page with its only page
    const err = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 7 }, ctx));
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toMatch(/no page 7/);
    expect(err.details.pages).toBe(1);
    const ok = (await tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1 }, ctx)) as any;
    expect(ok.page).toBe(1);
  });

  it("list_watches: a title that cannot be read says why, instead of looking like 'no copies'", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: fixture("availability") });
    await tool("watch_title").handler({ library: "tpl", title_id: "S234C3970025", check_every: "day" }, ctx);
    ctx.cache.clear();
    web.serve("/v2/record/S234C3970025", null, {}, 200); // the site changes after the watch was made: the page loses its data
    const { watches } = (await tool("list_watches").handler({ check_now: true }, ctx)) as any;
    expect(watches).toHaveLength(1);
    expect(watches[0].current).toBeNull();
    expect(watches[0].check_error.code).toBe("SITE_CHANGED");
    const plain = (await tool("list_watches").handler({ check_now: false }, ctx)) as any;
    expect(plain.watches[0].check_error).toBeNull();
  });

  it("an unknown branch is NOT_FOUND in every tool that takes one", async () => {
    const { web, ctx, tool } = setup();
    web.serve("/v2/locations", fixture("locations"));
    web.serve("/v2/events", fixture("events"));
    web.serve("/v2/search", fixture("search"));
    const viaSearch = await failure(() => tool("search_catalog").handler({ library: "tpl", query: "dune", search_type: "keyword", page: 1, available_at_branch: "Hogwarts" }, ctx));
    const viaEvents = await failure(() => tool("list_events").handler({ library: "tpl", branch: "Hogwarts", page: 1, limit: 20 }, ctx));
    const viaBranch = await failure(() => tool("get_branch").handler({ library: "tpl", branch: "Hogwarts" }, ctx));
    expect([viaSearch.code, viaEvents.code, viaBranch.code]).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
  });

  it("a malformed address in a search result is skipped, not a crash", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("https://TPL.ca/x")).toBe("tpl.ca");
  });
});

describe("the page limit", () => {
  it(`never runs more than the limit at once, and serves waiters in order`, async () => {
    expect(MAX_CONCURRENT_PAGES).toBeGreaterThan(0);
    const slots = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const finished: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        slots.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          finished.push(i);
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(finished).toHaveLength(12);
    expect(finished.slice(0, 3).sort()).toEqual([0, 1, 2]);
    expect(slots.queued).toBe(0);
  });

  it("a task that throws gives its slot back", async () => {
    const slots = new Semaphore(1);
    await expect(slots.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await slots.run(async () => "next")).toBe("next");
  });
});

describe("the per-call log line", () => {
  async function connect() {
    const lines: CallLog[] = [];
    const web = new FakeWeb();
    const ctx = createContext({ ...TEST_CONFIG, log: true }, web);
    ctx.log = (entry) => lines.push(entry);
    const server = buildServer(() => ctx);
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { web, client, lines };
  }

  it("records tool, duration, cache hit or miss, and the error code", async () => {
    const { web, client, lines } = await connect();
    web.serve("/v2/search", fixture("search"));
    const args = { library: "tpl", query: "a very private search" };
    await client.callTool({ name: "search_catalog", arguments: args });
    await client.callTool({ name: "search_catalog", arguments: args });
    await client.callTool({ name: "get_title", arguments: { library: "tpl", title_id: "nonsense" } });
    expect(lines.map((l) => [l.tool, l.ok, l.cached, l.error])).toEqual([
      ["search_catalog", true, false, undefined],
      ["search_catalog", true, true, undefined],
      ["get_title", false, null, "INVALID_INPUT"],
    ]);
    for (const l of lines) expect(l.ms).toBeGreaterThanOrEqual(0);
    // What someone searched for, and the key, never reach the log.
    expect(JSON.stringify(lines)).not.toMatch(/private search|"test"/);
  });

  it("logs a contract break as SITE_CHANGED", async () => {
    const { web, client, lines } = await connect();
    web.serve("/v2/search", null, {}, 200);
    await client.callTool({ name: "search_catalog", arguments: { library: "tpl", query: "dune" } });
    expect(lines.at(-1)).toMatchObject({ tool: "search_catalog", ok: false, error: "SITE_CHANGED" });
  });

  it("is silent when logging is off", async () => {
    const lines: CallLog[] = [];
    const ctx = createContext({ ...TEST_CONFIG, log: false }, new FakeWeb());
    ctx.log = (entry) => lines.push(entry);
    const server = buildServer(() => ctx);
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "get_title", arguments: { library: "tpl", title_id: "nonsense" } });
    expect(lines).toHaveLength(0);
  });
});
