import { z } from "zod";
import { resolveLibrary } from "../core/context.js";
import { defineTool, libraryArg } from "../core/tool.js";
import { CheckSchema, runHealth } from "../health/checks.js";

export const healthCheck = defineTool({
  name: "health_check",
  title: "Check that the tools still work",
  description:
    "Run live checks against a library's website to confirm every Stacks tool still works, and report exactly what broke if the site changed. Checks page landmarks (TinyFish Fetch) and the data contract of each tool using known-good queries (TinyFish Browser). Set deep to also start a TinyFish Agent that inspects a failing page and explains what changed. Takes about 20 to 40 seconds. Run this when a tool returns SITE_CHANGED.",
  input: {
    library: libraryArg,
    deep: z.boolean().default(false).describe("If a check fails, start an Agent run to diagnose the failing page (result via get_job_result)."),
  },
  output: {
    healthy: z.boolean().describe("False if any check failed."),
    library: z.string(),
    summary: z.string(),
    platform_version: z.string().nullable().describe("Version of the library platform seen on the site now."),
    verified_platform_version: z.string().describe("Platform version these tools were last verified against."),
    checks: z.array(CheckSchema),
    diagnosis_job_id: z.string().nullable().describe("Pass to get_job_result for the Agent's diagnosis of the failing page."),
    diagnosis_error: z.string().nullable().describe("Why the Agent diagnosis could not be started, if it could not."),
    tinyfish_calls: z.record(z.string(), z.number()).describe("TinyFish calls this check made, by endpoint."),
    checked_at: z.string(),
  },
  handler: async (args, ctx) => runHealth(ctx, resolveLibrary(ctx, args.library ?? ctx.config.defaultLibrary ?? "tpl"), { deep: args.deep }),
});
