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
      try {
        const out = await def.handler(args, getContext());
        return { structuredContent: out as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        const e = toStacksError(err);
        e.details = { tool: def.name, ...e.details };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(e.toJSON()) }] };
      }
    },
  );
}

/** Provenance for data read just now (not from cache). */
export function liveSource(engines: Source["engines"], url: string | null = null): Source {
  return { engines, url, cached: false, retrieved_at: new Date().toISOString() };
}
