#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { createContext, resolveLibrary } from "./core/context.js";
import { StacksError, toStacksError } from "./core/errors.js";
import { formatReport, runHealth } from "./health/checks.js";
import { startHttp } from "./http.js";
import { buildServer, VERSION } from "./server.js";

const HELP = `stacks-mcp ${VERSION}
Give your AI agent a library card. Public-library tools for MCP clients, powered by TinyFish.

Usage:
  stacks-mcp                     Run as an MCP server over stdio (Claude Desktop, Claude Code, Cursor)
  stacks-mcp --http [--port N]   Run as a Streamable HTTP MCP server (ChatGPT, remote clients)
  stacks-mcp health [options]    Check that every tool still works against the live site

Health options:
  --library <id>   Library to check (default: tpl). Repeat to check several.
  --deep           If a check fails, start a TinyFish Agent run to diagnose it
  --json           Print the full report as JSON

Environment:
  TINYFISH_API_KEY        Required. Get one at https://agent.tinyfish.ai
  STACKS_DEFAULT_LIBRARY  Library id used when a tool call omits \`library\`
  STACKS_PROXY            off | auto (default) | tinyfish | <country code>
  STACKS_HTTP_TOKEN       Access token required by --http mode when using the server's key
  PORT                    Port for --http mode (default 3000)
  HOST                    Address --http mode listens on. Default: 127.0.0.1 when the server's
                          key is used without a token, otherwise 0.0.0.0
`;

function flagValues(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return void console.log(HELP);
  if (args.includes("--version") || args.includes("-v")) return void console.log(VERSION);
  const takesValue = ["--port", "--library"];
  const known = new Set(["health", "--http", "--deep", "--json", ...takesValue]);
  const stray = args.find((a, i) => !known.has(a) && !(i > 0 && takesValue.includes(args[i - 1]!)));
  if (stray !== undefined) {
    console.error(`stacks-mcp: unknown argument "${stray}". Run stacks-mcp --help for usage.`);
    process.exit(2);
  }
  // Convenience for local development: pick up a .env file if there is one.
  if (existsSync(".env")) {
    try {
      process.loadEnvFile(".env");
    } catch {
      /* ignore a malformed .env */
    }
  }

  if (args.includes("--http")) {
    const port = Number(flagValues(args, "--port")[0] ?? process.env.PORT ?? 3000);
    // In HTTP mode the server key is optional: callers may bring their own.
    const config = process.env.TINYFISH_API_KEY ? loadConfig() : { ...loadConfig({ ...process.env, TINYFISH_API_KEY: "unset" }), apiKey: "" };
    startHttp({ ...config, port });
    return;
  }

  const ctx = createContext(loadConfig());

  if (args[0] === "health") {
    const libraries = flagValues(args, "--library");
    const targets = (libraries.length ? libraries : [ctx.config.defaultLibrary ?? "tpl"]).map((l) => resolveLibrary(ctx, l));
    let healthy = true;
    const reports = [];
    for (const library of targets) {
      const report = await runHealth(ctx, library, { deep: args.includes("--deep") });
      reports.push(report);
      healthy &&= report.healthy;
      if (!args.includes("--json")) console.log(`${formatReport(report)}\n`);
    }
    if (args.includes("--json")) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
    await ctx.web.close();
    process.exit(healthy ? 0 : 1);
  }

  const server = buildServer(() => ctx);
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await ctx.web.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  const e = err instanceof StacksError ? err : toStacksError(err);
  console.error(`stacks-mcp: ${e.code}: ${e.message}\n${e.hint}`);
  process.exit(1);
});
