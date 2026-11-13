import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SourceSchema, type Source } from "../schemas.js";
import type { Context } from "./context.js";
import { toStacksError } from "./errors.js";

export interface ToolDef<I extends z.ZodRawShape, O extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  /** True if the tool creates or deletes something (a watch). Everything else is read-only. */
  writes?: boolean;
  /** True if the tool permanently removes something. */
  destructive?: boolean;
  handler: (args: z.infer<z.ZodObject<I>>, ctx: Context) => Promise<z.infer<z.ZodObject<O>>>;
}

export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export const libraryArg = z
  .string()
  .optional()
  .describe('Library system id such as "tpl" (Toronto), "vpl" (Vancouver), "chipublib" (Chicago). Get it from find_library. A city or library name also works.');

export const sourceField = { source: SourceSchema };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any, any>;

/** Register a tool: typed input, typed output, and errors that are never swallowed. */
export function register(server: McpServer, def: AnyTool, getContext: () => Context) {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      outputSchema: def.output,
      annotations: { readOnlyHint: !def.writes, destructiveHint: !!def.destructive, idempotentHint: !def.writes, openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      const started = Date.now();
      let ctx: Context | undefined;
      try {
        ctx = getContext();
        const out = await def.handler(args, ctx);
        logCall(ctx, { tool: def.name, ms: Date.now() - started, ok: true, cached: (out as { source?: Source }).source?.cached ?? null });
        return { structuredContent: out as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const e = toStacksError(err);
        e.details = { tool: def.name, ...e.details };
        logCall(ctx, { tool: def.name, ms: Date.now() - started, ok: false, cached: null, error: e.code });
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(e.toJSON()) }] };
      }
    },
  );
}

export interface CallLog {
  tool: string;
  ms: number;
  ok: boolean;
  /** True if the answer came from the cache, false if it was read live, null if the tool has no single source. */
  cached: boolean | null;
  /** The error code, when the call failed. */
  error?: string;
}

/**
 * One JSON line per tool call, on stderr. stdout carries the MCP protocol in stdio mode and
 * must stay clean. The line never holds arguments, results, messages or keys: what a person
 * searched for at a library is their business.
 */
function logCall(ctx: Context | undefined, entry: CallLog) {
  if (!ctx?.config.log) return;
  (ctx.log ?? defaultLog)(entry);
}

function defaultLog(entry: CallLog) {
  console.error(JSON.stringify({ t: new Date().toISOString(), event: "tool_call", ...entry }));
}

/** Provenance for data read just now (not from cache). */
export function liveSource(engines: Source["engines"], url: string | null = null): Source {
  return { engines, url, cached: false, retrieved_at: new Date().toISOString() };
}
