import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "./core/context.js";
import { register } from "./core/tool.js";
import { TOOLS } from "./tools/index.js";

export const VERSION = "0.1.2";

const INSTRUCTIONS = `Stacks gives you live access to public library websites (catalogue, branches, events) through typed tools. Data is read from the library's website at call time by TinyFish; it is not from memory or a search index.

Typical flow:
1. find_library("Toronto") -> library_id "tpl". Pass it as \`library\` to every other tool.
2. search_catalog -> title_id. Then check_availability (which branches have it on the shelf), estimate_wait (hold queue), or get_title (details).
3. list_branches / get_branch for hours and services. list_events for programs.
4. ask_library for open questions about services and policies (slow; may return a job_id for get_job_result).
5. watch_title to be told when availability changes.

Errors are structured: { error: { code, message, hint } }. SITE_CHANGED means the website changed and the tool is broken: tell the user, and run health_check for details. Never guess an answer after an error.`;

/** Build an MCP server exposing every Stacks tool. `getContext` is called per tool call. */
export function buildServer(getContext: () => Context): McpServer {
  const server = new McpServer({ name: "stacks", title: "Stacks: public library tools", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) register(server, tool, getContext);
  return server;
}

export { TOOLS } from "./tools/index.js";
export { createContext, type Context } from "./core/context.js";
export { loadConfig, type Config } from "./core/config.js";
export { StacksError, ERROR_CODES, type ErrorCode } from "./core/errors.js";
export type { LibraryAdapter } from "./adapters/types.js";
export * from "./schemas.js";
