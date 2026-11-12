import { z } from "zod";
import { resolveLibrary } from "../core/context.js";
import { agentSchema, jobId, jobState, parseJobId, JOB_KINDS } from "../core/jobs.js";
import { norm } from "../core/text.js";
import { defineTool, libraryArg, liveSource, sourceField } from "../core/tool.js";
import { JobStatusSchema } from "../schemas.js";

const AskResult = z.object({
  answer: z.string().describe("A direct answer to the question, in one to four sentences."),
  found: z.boolean().describe("True only if the website actually states the answer."),
  source_urls: z.array(z.string()).describe("Pages on the library's website where the answer was found."),
});

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "do", "does", "can", "i", "at", "in", "of", "to", "for", "and", "or", "have", "has", "how", "what", "where", "when", "there", "any", "my", "it", "on", "with", "library", "branch"]);

export const askLibrary = defineTool({
  name: "ask_library",
  title: "Ask about a library's services",
  description:
    "Answer an open-ended question about a library's services, policies or facilities by having a TinyFish Agent browse the library's own website. Use it for things the other tools do not cover, e.g. 'How do I get a card as a non-resident?', 'Can I book a study room at North York Central?', 'What are the overdue fines?'. Slower than the other tools (about 20 to 60 seconds). If it is still working it returns status 'running' with a job_id: call get_job_result with that id.",
  input: {
    library: libraryArg,
    question: z.string().min(5).max(400).describe("The question, in plain language. Name the branch if it is about one branch."),
  },
  output: {
    library: z.string(),
    status: JobStatusSchema,
    job_id: z.string().nullable().describe("Set while status is 'running'. Pass it to get_job_result."),
    answer: z.string().nullable(),
    found: z.boolean().nullable().describe("False if the website does not state the answer."),
    source_urls: z.array(z.string()),
    pages_consulted: z.array(z.object({ url: z.string(), title: z.string().nullable() })).describe("Pages found by search and read before the Agent started."),
    ...sourceField,
  },
  handler: async ({ library: lib, question }, ctx) => {
    const library = resolveLibrary(ctx, lib);
    const info = (await ctx.adapter.getLibrary(library)).data;
    const home = info.home_url ?? info.catalog_url;
    const site = new URL(home).host.replace(/^www\./, "");

    // 1. Search: find pages on the library's own site that look relevant.
    const hits = await ctx.web.search(`${question} ${info.name}`, { include_domains: site });
    const onSite = hits.filter((h) => new URL(h.url).host.endsWith(site)).slice(0, 3);

    // 2. Fetch: read them and pick the page that best matches the question as the Agent's starting point.
    const pages = onSite.length ? await ctx.web.fetch(onSite.map((h) => h.url)) : [];
    const words = norm(question).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w));
    const scored = pages
      .filter((p) => p.text)
      .map((p) => ({ page: p, score: words.filter((w) => norm(p.text ?? "").includes(w)).length }))
      .sort((a, b) => b.score - a.score);
    const startUrl = scored[0] && scored[0].score > 0 ? (scored[0].page.final_url ?? scored[0].page.url) : home;

    // 3. Agent: navigate and answer.
    const runId = await ctx.web.agentStart({
      url: startUrl,
      goal:
        `You are on the website of ${info.name}, a public library. Answer this question using only information on this website (${site}): "${question}". ` +
        "Start with the current page; follow at most a few links if it does not contain the answer. " +
        "If the website does not state the answer, set found to false and say what you could not find. " +
        "Do not log in, register, submit forms or leave this website.",
      output_schema: agentSchema(AskResult),
    });
    const run = await ctx.web.agentWait(runId, ctx.config.agentWaitMs);
    const state = jobState(run);
    const parsed = state.status === "completed" ? AskResult.safeParse(state.result) : null;

    return {
      library,
      status: state.status === "completed" && !parsed?.success ? ("failed" as const) : state.status,
      job_id: state.status === "running" ? jobId("ask", runId) : null,
      answer: parsed?.success ? parsed.data.answer : state.status === "failed" ? `The Agent run failed: ${state.error}` : null,
      found: parsed?.success ? parsed.data.found : null,
      source_urls: parsed?.success ? parsed.data.source_urls : [],
      pages_consulted: pages.filter((p) => p.text).map((p) => ({ url: p.final_url ?? p.url, title: p.title })),
      source: liveSource(["search", "fetch", "agent"], startUrl),
    };
  },
});

export const getJobResult = defineTool({
  name: "get_job_result",
  title: "Get the result of a running job",
  description:
    "Fetch the result of a slow TinyFish Agent run that another Stacks tool started (a job_id from ask_library, a fallback_job_id from an error, or a diagnosis_job_id from health_check). If status is still 'running', wait about 15 seconds and call again.",
  input: { job_id: z.string().describe("The job id exactly as returned by another tool.") },
  output: {
    job_id: z.string(),
    kind: z.enum(JOB_KINDS),
    status: JobStatusSchema,
    result: z.record(z.string(), z.unknown()).nullable().describe("The Agent's structured result once completed. For kind 'ask': { answer, found, source_urls }."),
    error: z.string().nullable(),
    agent_steps: z.number().int().nullable(),
    ...sourceField,
  },
  handler: async ({ job_id }, ctx) => {
    const { kind, runId } = parseJobId(job_id);
    const run = await ctx.web.agentGet(runId);
    const state = jobState(run);
    return {
      job_id,
      kind,
      status: state.status,
      result: state.status === "completed" ? state.result : null,
      error: state.status === "failed" ? state.error : null,
      agent_steps: run.steps,
      source: liveSource(["agent"], null),
    };
  },
});
