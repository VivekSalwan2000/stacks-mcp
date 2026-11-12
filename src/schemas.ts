/**
 * The public, typed data model. These are the shapes agents receive; they are
 * deliberately independent of how any one library platform stores its data.
 */
import { z } from "zod";

export const SourceSchema = z
  .object({
    engines: z.array(z.enum(["search", "fetch", "browser", "agent", "monitor"])).describe("TinyFish endpoints that produced this result."),
    url: z.string().nullable().describe("The page this data was read from."),
    cached: z.boolean().describe("True if served from Stacks' short-lived cache."),
    retrieved_at: z.string().describe("ISO timestamp of when the data was read from the site."),
  })
  .describe("Provenance of the data.");
export type Source = z.infer<typeof SourceSchema>;

export const LibrarySchema = z.object({
  library_id: z.string().describe("Stacks id for the library system, e.g. 'tpl'. Pass this as `library` to every other tool."),
  name: z.string(),
  catalog_url: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable().describe("State or province."),
  country: z.string().nullable().describe("ISO 3166-1 alpha-2 country code."),
  verified: z.boolean().describe("True if the catalogue was confirmed reachable (from the built-in directory or a live check)."),
});
export type Library = z.infer<typeof LibrarySchema>;

export const AvailabilitySummarySchema = z.object({
  status: z.enum(["available", "all_copies_in_use", "on_order", "unavailable", "unknown"]),
  total_copies: z.number().int().nullable(),
  available_copies: z.number().int().nullable(),
  holds: z.number().int().nullable().describe("People currently waiting for this title."),
  on_order_copies: z.number().int().nullable(),
});
export type AvailabilitySummary = z.infer<typeof AvailabilitySummarySchema>;

export const FormatSchema = z.object({
  code: z.string().describe("Platform format code, e.g. BK, EBOOK, DVD."),
  label: z.string().describe("Human-readable format, e.g. Book, eBook, DVD."),
});

export const TitleSchema = z.object({
  title_id: z.string().describe("Stable id for this edition. Pass to get_title, check_availability, estimate_wait, watch_title."),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  format: FormatSchema,
  year: z.string().nullable(),
  language: z.string().nullable().describe("ISO 639-2 language code, e.g. eng."),
  call_number: z.string().nullable(),
  series: z.array(z.string()),
  audience: z.array(z.string()),
  rating: z.object({ average_out_of_5: z.number(), count: z.number().int() }).nullable(),
  availability: AvailabilitySummarySchema,
  other_formats: z
    .array(z.object({ title_id: z.string(), format: FormatSchema, year: z.string().nullable(), availability: AvailabilitySummarySchema }))
    .describe("The same work in other formats or editions."),
  url: z.string(),
});
export type Title = z.infer<typeof TitleSchema>;

export const TitleDetailsSchema = TitleSchema.extend({
  description: z.string().nullable(),
  contributors: z.array(z.object({ name: z.string(), roles: z.array(z.string()) })),
  publisher: z.string().nullable(),
  physical_description: z.string().nullable(),
  isbns: z.array(z.string()),
  subjects: z.array(z.string()),
  genres: z.array(z.string()),
});
export type TitleDetails = z.infer<typeof TitleDetailsSchema>;

export const CopySchema = z.object({
  status: z.enum(["on_shelf", "checked_out", "in_transit", "on_hold_shelf", "library_use_only", "on_order", "unavailable"]),
  status_label: z.string().describe("The library's own wording for the status."),
  collection: z.string().nullable(),
  call_number: z.string().nullable(),
  due_date: z.string().nullable().describe("YYYY-MM-DD, when a checked-out copy is due back."),
});
export type Copy = z.infer<typeof CopySchema>;

export const BranchAvailabilitySchema = z.object({
  branch_code: z.string(),
  branch_name: z.string(),
  copies_total: z.number().int(),
  copies_on_shelf: z.number().int().describe("Copies you could walk in and borrow right now."),
  next_due_date: z.string().nullable().describe("Earliest due date among checked-out copies at this branch."),
  copies: z.array(CopySchema),
});
export type BranchAvailability = z.infer<typeof BranchAvailabilitySchema>;

export const HoursSchema = z.object({
  day: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
  open: z.string().nullable().describe("HH:MM, 24-hour local time. Null when closed."),
  close: z.string().nullable(),
});

export const BranchSummarySchema = z.object({
  branch_code: z.string().describe("Pass to get_branch, list_events(branch) or search_catalog(available_at_branch)."),
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  phone: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  distance_km: z.number().nullable().describe("Distance from the coordinates you passed, if any."),
  open_now: z.boolean().nullable(),
  today: z.object({ open: z.string().nullable(), close: z.string().nullable(), note: z.string().nullable() }).describe("Today's hours in the branch's local time."),
});
export type BranchSummary = z.infer<typeof BranchSummarySchema>;

export const BranchSchema = BranchSummarySchema.extend({
  timezone: z.string().nullable(),
  hours: z.array(HoursSchema),
  upcoming_closures: z.array(z.object({ name: z.string(), start_date: z.string(), end_date: z.string(), open: z.string().nullable(), close: z.string().nullable() })),
  services: z.array(z.string()).describe("Facilities and services at this branch, e.g. Meeting Room, 3D Printer."),
  highlights: z.array(z.string()),
  accessibility: z.string().nullable(),
  parking: z.string().nullable(),
  directions: z.string().nullable(),
  url: z.string().nullable(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const EventSchema = z.object({
  event_id: z.string(),
  title: z.string(),
  start: z.string().describe("Local start: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day events."),
  end: z.string().nullable(),
  all_day: z.boolean(),
  branch_code: z.string().nullable().describe("Null for online events."),
  branch_name: z.string().nullable(),
  room: z.string().nullable(),
  is_online: z.boolean(),
  description: z.string().nullable(),
  audiences: z.array(z.string()),
  types: z.array(z.string()),
  languages: z.array(z.string()),
  registration_required: z.boolean(),
  registration_closed: z.boolean(),
  is_full: z.boolean(),
  is_cancelled: z.boolean(),
  is_recurring: z.boolean(),
  url: z.string(),
});
export type LibraryEvent = z.infer<typeof EventSchema>;

export const JobStatusSchema = z.enum(["completed", "running", "failed"]);
