import { z } from "zod";
import { resolveLibrary } from "../core/context.js";
import { StacksError, toStacksError } from "../core/errors.js";
import { defineTool, libraryArg, liveSource, sourceField } from "../core/tool.js";
import type { Watch } from "../core/web.js";
import { AvailabilitySummarySchema } from "../schemas.js";

const SCHEDULES = { hour: "0 * * * *", "6_hours": "0 */6 * * *", day: "0 9 * * *" } as const;
const PREFIX = "stacks";

/** Watches are TinyFish Monitors whose name encodes what they watch: stacks|<library>|<title_id>|<title> */
function decodeName(name: string | null) {
  const [prefix, library, title_id, ...rest] = (name ?? "").split("|");
  return prefix === PREFIX && library && title_id ? { library, title_id, title: rest.join("|") || null } : null;
}

const WatchSchema = z.object({
  watch_id: z.string(),
  library: z.string(),
  title_id: z.string(),
  title: z.string().nullable(),
  status: z.string().describe("active, paused, failed or creating."),
  schedule_cron: z.string(),
  notifies: z.string().describe("Where change notifications go."),
  last_error: z.string().nullable(),
  created_at: z.string(),
  current: AvailabilitySummarySchema.nullable().describe("Live availability, when check_now was requested."),
  check_error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .describe("Set when check_now was requested and the live read failed, e.g. SITE_CHANGED. `current` is then null because it is unknown, not because nothing is available."),
});

/** A webhook must be reachable from the internet: TinyFish calls it, not this machine. */
function isPublicHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === "localhost" || h.startsWith("[") || /\.(localhost|local|internal|lan)$/.test(h)) return false;
    return !/^(0|10|127)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return false;
  }
}

export const watchTitle = defineTool({
  name: "watch_title",
  title: "Watch a title for availability",
  description:
    "Create a standing watch on a title using TinyFish Monitor. TinyFish re-reads the title's page on a schedule and detects when its availability changes (for example a copy comes back on the shelf). Notifications go to the webhook you pass, or to the alerts set up in the TinyFish dashboard. Use list_watches to see watches and their current availability.",
  writes: true,
  input: {
    library: libraryArg,
    title_id: z.string().describe("A title_id from search_catalog."),
    check_every: z.enum(["hour", "6_hours", "day"]).default("6_hours").describe("How often TinyFish re-checks the page."),
    webhook_url: z
      .string()
      .url()
      .startsWith("https://", "Must be an https URL")
      .refine(isPublicHost, "Must be a public address, not localhost or a private network")
      .optional()
      .describe("Optional public HTTPS endpoint TinyFish calls when the page changes."),
  },
  output: {
    watch: WatchSchema,
    availability_at_creation: AvailabilitySummarySchema,
    already_existed: z.boolean().describe("True if this title was already being watched; the existing watch is returned and nothing new is created."),
    ...sourceField,
  },
  handler: async (args, ctx) => {
    const library = resolveLibrary(ctx, args.library);
    // Confirms the title exists and gives the baseline before creating the monitor.
    const { data } = await ctx.adapter.getTitle(library, args.title_id);
    const title = data.details.title.replace(/\|/g, " ").slice(0, 80);
    const titleId = data.details.title_id; // the library's own id, if the site redirected the one asked for
    const url = ctx.adapter.recordUrl(library, titleId);
    const describe = (w: Watch) => ({
      watch_id: w.id,
      library,
      title_id: titleId,
      title,
      status: w.status,
      schedule_cron: w.schedule_cron,
      notifies: w.webhook_url ? `webhook ${w.webhook_url}` : "TinyFish dashboard alerts",
      last_error: w.last_error,
      created_at: w.created_at,
      current: data.summary,
      check_error: null,
    });
    // One watch per title: asking again returns the watch that is already there.
    const existing = (await ctx.web.watchList()).find((w) => {
      const meta = decodeName(w.name);
      return meta?.library === library && meta.title_id === titleId;
    });
    if (existing) {
      return { watch: describe(existing), availability_at_creation: data.summary, already_existed: true, source: liveSource(["browser", "monitor"], url) };
    }
    const { watch } = await ctx.web.watchCreate({
      name: [PREFIX, library, titleId, title].join("|"),
      url,
      schedule_cron: SCHEDULES[args.check_every],
      purpose: `The availability of "${title}" (${data.details.format.label}) changes: a copy becomes available to borrow, or the number of holds or copies changes.`,
      webhook_url: args.webhook_url,
    });
    return { watch: describe(watch), availability_at_creation: data.summary, already_existed: false, source: liveSource(["browser", "monitor"], url) };
  },
});

export const listWatches = defineTool({
  name: "list_watches",
  title: "List watches",
  description: "List the title watches created with watch_title. Set check_now to also read each title's live availability, so you can tell the user whether a copy is available yet.",
  input: {
    check_now: z.boolean().default(false).describe("Also fetch live availability for each watched title (up to 5)."),
  },
  output: { watches: z.array(WatchSchema), ...sourceField },
  handler: async ({ check_now }, ctx) => {
    const all = await ctx.web.watchList();
    const mine = all.map((w) => ({ w, meta: decodeName(w.name) })).filter((x) => x.meta !== null);
    const watches = await Promise.all(
      mine.map(async ({ w, meta }, i) => {
        let current = null;
        let check_error: { code: string; message: string } | null = null;
        if (check_now && i < 5) {
          try {
            current = (await ctx.adapter.getTitle(meta!.library, meta!.title_id)).data.summary;
          } catch (err) {
            // One unreadable title must not hide the other watches, but it must not look like "no copies" either.
            const e = toStacksError(err);
            check_error = { code: e.code, message: e.message };
          }
        }
        return {
          watch_id: w.id,
          library: meta!.library,
          title_id: meta!.title_id,
          title: meta!.title,
          status: w.status,
          schedule_cron: w.schedule_cron,
          notifies: w.webhook_url ? `webhook ${w.webhook_url}` : "TinyFish dashboard alerts",
          last_error: w.last_error,
          created_at: w.created_at,
          current,
          check_error,
        };
      }),
    );
    return { watches, source: liveSource(check_now ? ["monitor", "browser"] : ["monitor"], null) };
  },
});

export const cancelWatch = defineTool({
  name: "cancel_watch",
  title: "Cancel a watch",
  description:
    "Stop and permanently delete a watch created with watch_title. TinyFish stops re-checking the title and sends no more notifications. Only watches made by Stacks can be cancelled; get the watch_id from list_watches. Set dry_run to see which watch would be cancelled without cancelling it, for example to confirm with the user first.",
  writes: true,
  destructive: true,
  input: {
    watch_id: z.string().describe("The watch_id from watch_title or list_watches."),
    dry_run: z.boolean().default(false).describe("If true, only report which watch would be cancelled. Nothing is deleted."),
  },
  output: {
    cancelled: z.boolean().describe("True if the watch was deleted. Always false on a dry run."),
    dry_run: z.boolean(),
    watch_id: z.string(),
    library: z.string(),
    title_id: z.string(),
    title: z.string().nullable(),
    ...sourceField,
  },
  handler: async ({ watch_id, dry_run }, ctx) => {
    // Only delete monitors Stacks created: never touch the user's other TinyFish monitors.
    const target = (await ctx.web.watchList()).find((w) => w.id === watch_id);
    const meta = target ? decodeName(target.name) : null;
    if (!meta) {
      throw new StacksError("NOT_FOUND", `No Stacks watch with id ${watch_id}.`, { hint: "Call list_watches to see valid watch ids." });
    }
    if (!dry_run) await ctx.web.watchCancel(watch_id);
    return { cancelled: !dry_run, dry_run, watch_id, ...meta, source: liveSource(["monitor"], null) };
  },
});
