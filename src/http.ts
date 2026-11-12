/**
 * Streamable HTTP transport, for remote MCP clients such as ChatGPT.
 *
 * Stateless: every POST /mcp gets a fresh MCP server bound to a shared
 * context, so it scales horizontally and survives restarts.
 *
 * Whose TinyFish credits are used:
 *   - If the request carries an `x-tinyfish-api-key` header, that key is used.
 *   - Otherwise the server's own TINYFISH_API_KEY is used, but only if the
 *     request presents STACKS_HTTP_TOKEN (as a Bearer token or as the path
 *     /mcp/<token>). Without STACKS_HTTP_TOKEN set, the server's key is open
 *     to anyone who can reach it: only do that on localhost.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./core/config.js";
import { createContext, type Context } from "./core/context.js";
import { buildServer, VERSION } from "./server.js";

const MAX_BODY = 1_000_000;
const MAX_KEYED_CONTEXTS = 20;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export function startHttp(config: Partial<Config> & { port: number }, env: NodeJS.ProcessEnv = process.env) {
  const token = env.STACKS_HTTP_TOKEN?.trim() || null;
  const shared: Context | null = config.apiKey ? createContext(config as Config) : null;
  const keyed = new Map<string, Context>();

  const contextFor = (req: IncomingMessage, path: string): Context | { status: number; message: string } => {
    const own = req.headers["x-tinyfish-api-key"];
    if (typeof own === "string" && own.trim()) {
      const key = own.trim();
      let ctx = keyed.get(key);
      if (!ctx) {
        if (keyed.size >= MAX_KEYED_CONTEXTS) {
          const oldest = keyed.keys().next().value as string;
          void keyed.get(oldest)?.web.close();
          keyed.delete(oldest);
        }
        ctx = createContext({ ...(config as Config), apiKey: key });
        keyed.set(key, ctx);
      }
      return ctx;
    }
    if (!shared) return { status: 401, message: "Send your TinyFish API key in the x-tinyfish-api-key header." };
    if (token) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const inPath = path.startsWith("/mcp/") ? decodeURIComponent(path.slice(5)) : null;
      if (bearer !== token && inPath !== token) return { status: 401, message: "Missing or wrong access token." };
    }
    return shared;
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (req.method === "GET" && (path === "/" || path === "/healthz")) {
        return json(res, 200, { name: "stacks-mcp", version: VERSION, mcp_endpoint: "/mcp", transport: "streamable-http", docs: "https://github.com/VivekSalwan2000/stacks-mcp" });
      }
      if (path !== "/mcp" && !path.startsWith("/mcp/")) return json(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." });
      if (req.method !== "POST") {
        return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: use POST." }, id: null });
      }
      const ctx = contextFor(req, path);
      if ("status" in ctx) return json(res, ctx.status, { jsonrpc: "2.0", error: { code: -32001, message: ctx.message }, id: null });

      const body = await readBody(req);
      const mcp = buildServer(() => ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Bad request: ${(err as Error).message}` }, id: null });
    }
  });

  server.listen(config.port, () => {
    const mode = shared ? (token ? "server key, token required" : "server key, NO token (anyone who can reach this port can use your TinyFish credits)") : "bring-your-own key (x-tinyfish-api-key header)";
    console.error(`stacks-mcp ${VERSION} listening on http://localhost:${config.port}/mcp  [${mode}]`);
  });

  const shutdown = async () => {
    server.close();
    await Promise.all([shared?.web.close(), ...[...keyed.values()].map((c) => c.web.close())]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
