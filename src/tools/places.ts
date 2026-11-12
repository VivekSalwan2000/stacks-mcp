import { z } from "zod";
import { summarizeBranch } from "../adapters/bibliocommons/parse.js";
import { resolveLibrary } from "../core/context.js";
import { StacksError } from "../core/errors.js";
import { matchLabel, norm } from "../core/text.js";
import { defineTool, libraryArg, sourceField } from "../core/tool.js";
import { BranchSchema, BranchSummarySchema, EventSchema } from "../schemas.js";

const dateArg = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "Not a real calendar date")
    .optional()
    .describe(`${what} (YYYY-MM-DD).`);

export const listBranches = defineTool({
  name: "list_branches",
  title: "List branches",
  description:
    "List a library system's branches with address, phone, today's hours and whether each is open right now. Pass coordinates to sort by distance. Use get_branch for a branch's full weekly hours and services.",
  input: {
    library: libraryArg,
    near_latitude: z.number().min(-90).max(90).optional().describe("Sort by distance from this point (requires near_longitude)."),
    near_longitude: z.number().min(-180).max(180).optional(),
    open_now: z.boolean().optional().describe("Only branches that are open right now."),
    name_contains: z.string().optional().describe("Only branches whose name contains this text."),
    limit: z.number().int().min(1).max(200).default(20),
  },
  output: {
    library: z.string(),
    total: z.number().int().describe("Branches in the system matching the filters."),
    branches: z.array(BranchSummarySchema),
    ...sourceField,
  },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    if ((args.near_latitude === undefined) !== (args.near_longitude === undefined)) {
      throw new StacksError("INVALID_INPUT", "Pass both near_latitude and near_longitude, or neither.");
    }
    const { data, source } = await ctx.adapter.listBranches(library);
    const from = args.near_latitude !== undefined ? { lat: args.near_latitude, lng: args.near_longitude as number } : undefined;
    let rows = data.map((b) => summarizeBranch(b, from));
    if (args.open_now) rows = rows.filter((b) => b.open_now === true);
    if (args.name_contains) rows = rows.filter((b) => norm(b.name).includes(norm(args.name_contains!)));
    if (from) rows.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
    return { library, total: rows.length, branches: rows.slice(0, args.limit), source };
  },
});

export const getBranch = defineTool({
  name: "get_branch",
  title: "Get branch details",
  description:
    "Everything about one branch: weekly hours, whether it is open now, upcoming holiday closures, services and facilities (meeting rooms, printing, makerspaces), accessibility, parking and directions.",
  input: {
    library: libraryArg,
    branch: z.string().min(1).describe('Branch name or code, e.g. "Yorkville" or "YO".'),
  },
  output: { library: z.string(), branch: BranchSchema, ...sourceField },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    const { data, source } = await ctx.adapter.listBranches(library);
    const hit = data.find((b) => b.branch_code.toLowerCase() === args.branch.toLowerCase()) ?? matchLabel(args.branch, data, (b) => [b.name]);
    if (!hit) {
      throw new StacksError("NOT_FOUND", `No branch matching "${args.branch}" at this library.`, {
        hint: "Call list_branches to see valid branch names and codes.",
        details: { examples: data.slice(0, 10).map((b) => `${b.name} (${b.branch_code})`) },
      });
    }
    return { library, branch: hit, source };
  },
});

export const listEvents = defineTool({
  name: "list_events",
  title: "List events and programs",
  description:
    "Find events and programs at a library: storytimes, book clubs, classes, author talks. Filter by branch, date range, audience (e.g. kids, teens, adults) and type. Returns typed events with local start and end times and whether registration is required.",
  input: {
    library: libraryArg,
    branch: z.string().optional().describe("Only events at this branch (name or code)."),
    start_date: dateArg("First day to include"),
    end_date: dateArg("Last day to include"),
    audience: z.string().optional().describe('Audience name, matched loosely, e.g. "school age", "teens", "adults". Valid values are returned in available_filters.'),
    event_type: z.string().optional().describe('Event type, matched loosely, e.g. "book club", "crafts". Valid values are returned in available_filters.'),
    query: z.string().optional().describe("Keywords to search event titles and descriptions."),
    page: z.number().int().min(1).max(100).default(1).describe("Results page, up to 20 events per page."),
    limit: z.number().int().min(1).max(20).default(20).describe("Return at most this many events from the page. Use a small number when you only need the next few."),
  },
  output: {
    library: z.string(),
    total: z.number().int(),
    page: z.number().int(),
    pages: z.number().int(),
    events: z.array(EventSchema),
    available_filters: z.object({ audiences: z.array(z.string()), event_types: z.array(z.string()) }).describe("Valid values for the audience and event_type inputs at this library."),
    ...sourceField,
  },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    if (args.start_date && args.end_date && args.end_date < args.start_date) {
      throw new StacksError("INVALID_INPUT", "end_date is before start_date.");
    }
    const { data, source } = await ctx.adapter.listEvents(library, {
      branch: args.branch,
      start_date: args.start_date,
      end_date: args.end_date,
      audience: args.audience,
      event_type: args.event_type,
      query: args.query,
      page: args.page,
    });
    return { library, total: data.total, page: data.page, pages: data.pages, events: data.events.slice(0, args.limit), available_filters: data.filters, source };
  },
});
