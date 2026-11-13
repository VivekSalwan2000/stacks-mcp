/**
 * The protocol layer, offline: what an MCP client actually sees over the wire,
 * and who the HTTP server lets in.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { createContext } from "../src/core/context.js";
import { loadConfig } from "../src/core/config.js";
import { StacksError } from "../src/core/errors.js";
import { startHttp } from "../src/http.js";
import { buildServer, TOOLS, VERSION } from "../src/server.js";
import { fixture, FakeWeb, TEST_CONFIG } from "./helpers.js";

async function connect() {
  const web = new FakeWeb();
  const ctx = createContext(TEST_CONFIG, web);
  const server = buildServer(() => ctx);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { web, client };
}

describe("over the MCP protocol", () => {
  it("lists every tool with typed input, typed output and honest hints", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect(t.description!.length, t.name).toBeGreaterThan(40);
    }
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.cancel_watch).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.watch_title).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.search_catalog).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(client.getServerVersion()).toMatchObject({ name: "stacks", version: VERSION });
    expect(client.getInstructions()).toContain("find_library");
  });

  it("returns structured data that matches the tool's output schema", async () => {
    const { web, client } = await connect();
    web.serve("/v2/record/S234C3970025", fixture("record"), { availability: fixture("availability") });
    const res = await client.callTool({ name: "get_title", arguments: { library: "tpl", title_id: "S234C3970025" } });
    expect(res.isError).toBeFalsy();
    const data = res.structuredContent as any;
    expect(data.title.title_id).toBe("S234C3970025");
    expect(data.source.engines).toContain("browser");
    expect(JSON.parse((res.content as any)[0].text)).toEqual(data);
  });

  it("returns a failure as a structured error, never as empty data", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "cancel_watch", arguments: { watch_id: "nope" } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const { error } = JSON.parse((res.content as any)[0].text);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("list_watches");
    expect(error.details.tool).toBe("cancel_watch");
  });

  it("rejects arguments that do not match the input schema", async () => {
    const { web, client } = await connect();
    const res = await client.callTool({ name: "search_catalog", arguments: { library: "tpl", query: "x".repeat(201) } });
    expect(res.isError).toBe(true);
    expect(web.usage.browser).toBe(0);
  });
});

describe("configuration", () => {
  it("fails with CONFIG_ERROR and a hint when the TinyFish key is missing", () => {
    try {
      loadConfig({});
      throw new Error("expected loadConfig to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(StacksError);
      expect((err as StacksError).code).toBe("CONFIG_ERROR");
    }
  });

  it("reads settings from the environment", () => {
    expect(loadConfig({ TINYFISH_API_KEY: " k ", STACKS_DEFAULT_LIBRARY: "TPL", PORT: "8080" })).toMatchObject({ apiKey: "k", defaultLibrary: "tpl", proxy: "auto", port: 8080 });
  });
});

describe("HTTP transport: who gets in", () => {
  const servers: Array<ReturnType<typeof startHttp>> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function serve(config: { apiKey?: string }, env: NodeJS.ProcessEnv) {
    const server = startHttp({ ...TEST_CONFIG, ...config, apiKey: config.apiKey, port: 0 }, { HOST: "127.0.0.1", ...env });
    servers.push(server);
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
    const post = (path: string, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    return { base, post };
  }

  it("with a token set, only requests that present it reach the server's key", async () => {
    const { base, post } = await serve({ apiKey: "server-key" }, { STACKS_HTTP_TOKEN: "test-token" });
    expect((await post("/mcp")).status).toBe(401);
    expect((await post("/mcp", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("/mcp/wrong")).status).toBe(401);
    expect((await post("/mcp", { authorization: "Bearer test-token" })).status).toBe(200);
    expect((await post("/mcp/test-token")).status).toBe(200);
    // A caller's own TinyFish key needs no token: it spends their credits, not the server's.
    expect((await post("/mcp", { "x-tinyfish-api-key": "their-key" })).status).toBe(200);

    const info = await (await fetch(`${base}/healthz`)).json();
    expect(info).toMatchObject({ name: "stacks-mcp", version: VERSION, mcp_endpoint: "/mcp" });
    expect(JSON.stringify(info)).not.toContain("server-key");
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });

  it("without a token, refuses requests sent from another website", async () => {
    const { post } = await serve({ apiKey: "server-key" }, {});
    expect((await post("/mcp", { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/mcp", { origin: "http://localhost:5173" })).status).toBe(200);
    expect((await post("/mcp")).status).toBe(200);
  });

  it("without a server key, asks the caller for their own", async () => {
    const { post } = await serve({}, {});
    const res = await post("/mcp");
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain("x-tinyfish-api-key");
  });

  it("answers malformed JSON with 400, not a crash", async () => {
    const { base } = await serve({ apiKey: "server-key" }, {});
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });
});
