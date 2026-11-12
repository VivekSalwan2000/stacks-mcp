/**
 * Background jobs for slow TinyFish Agent runs.
 *
 * An Agent run can outlast an MCP client's tool-call timeout. Agent-backed
 * tools therefore wait a bounded time and, if the run is still going, return
 * a job id the assistant can poll with get_job_result. The id encodes the
 * TinyFish run id, so jobs survive restarts and work across server instances.
 */
import { z } from "zod";
import { StacksError } from "./errors.js";
import type { AgentRun, Web } from "./web.js";

export const JOB_KINDS = ["ask", "search", "availability", "diagnosis"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function jobId(kind: JobKind, runId: string): string {
  return `${kind}.${runId}`;
}

export function parseJobId(id: string): { kind: JobKind; runId: string } {
  const dot = id.indexOf(".");
  const kind = id.slice(0, dot) as JobKind;
  const runId = id.slice(dot + 1);
  if (dot < 1 || !JOB_KINDS.includes(kind) || !/^[0-9a-f-]{16,}$/i.test(runId)) {
    throw new StacksError("INVALID_INPUT", `"${id}" is not a valid job_id.`, { hint: "Use the job_id exactly as a Stacks tool returned it." });
  }
  return { kind, runId };
}

export type JobState =
  | { status: "running" }
  | { status: "completed"; result: Record<string, unknown> }
  | { status: "failed"; error: string };

export function jobState(run: AgentRun): JobState {
  if (run.status === "PENDING" || run.status === "RUNNING") return { status: "running" };
  if (run.status === "COMPLETED" && run.result) return { status: "completed", result: run.result };
  return { status: "failed", error: run.error ?? `Agent run ended with status ${run.status} and no result.` };
}

export async function startJob(web: Web, kind: JobKind, params: { url: string; goal: string; output_schema?: Record<string, unknown> }): Promise<string> {
  return jobId(kind, await web.agentStart(params));
}

/** JSON Schema for a TinyFish Agent's structured output, in the subset TinyFish accepts. */
export function agentSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([k, v]) => !(["$schema", "additionalProperties"].includes(k) || (k === "description" && typeof v === "string")))
          .map(([k, v]) => [k, strip(v)]),
      );
    }
    return node;
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}
