/**
 * The contract every library-platform adapter implements.
 *
 * To support a new platform (Aspen Discovery, Koha, Polaris, ...), implement
 * this interface in `src/adapters/<platform>/` and register it in
 * `src/adapters/index.ts`. See docs/ADDING_AN_ADAPTER.md.
 */
import type {
  AvailabilitySummary,
  Branch,
  BranchAvailability,
  LibraryEvent,
  Source,
  Title,
  TitleDetails,
} from "../schemas.js";

export interface Sourced<T> {
  data: T;
  source: Source;
}

export interface LibraryInfo {
  library_id: string;
  name: string;
  catalog_url: string;
  home_url: string | null;
  timezone: string | null;
  /** Version string of the platform software, used to detect upgrades. */
  platform_version: string | null;
}

export type SearchType = "keyword" | "title" | "author" | "subject" | "series";

export interface SearchParams {
  query: string;
  search_type: SearchType;
  format?: string;
  available_at_branch?: string;
  page: number;
}

export interface SearchResult {
  total: number;
  page: number;
  pages: number;
  did_you_mean: string | null;
  titles: Title[];
}

export interface TitleRecord {
  details: TitleDetails;
  summary: AvailabilitySummary;
  branches: BranchAvailability[];
}

export interface EventParams {
  branch?: string;
  start_date?: string;
  end_date?: string;
  audience?: string;
  event_type?: string;
  query?: string;
  page: number;
}

export interface EventResult {
  total: number;
  page: number;
  pages: number;
  events: LibraryEvent[];
  /** Valid values for the `audience` and `event_type` filters at this library. */
  filters: { audiences: string[]; event_types: string[] };
}

/** A cheap page-level check used by the health check's first layer (TinyFish Fetch). */
export interface Landmark {
  name: string;
  url: string;
  /** Text that must appear on the page if its layout is intact. */
  must_contain: string[];
}

export interface LibraryAdapter {
  readonly platform: string;
  /** True if `id` is syntactically a library id on this platform. */
  validId(id: string): boolean;
  catalogUrl(id: string): string;
  recordUrl(id: string, titleId: string): string;
  getLibrary(id: string): Promise<Sourced<LibraryInfo>>;
  search(id: string, params: SearchParams): Promise<Sourced<SearchResult>>;
  getTitle(id: string, titleId: string): Promise<Sourced<TitleRecord>>;
  listBranches(id: string): Promise<Sourced<Branch[]>>;
  listEvents(id: string, params: EventParams): Promise<Sourced<EventResult>>;
  landmarks(id: string): Landmark[];
  /** Goal + output schema for a slower Agent run that extracts the same data, used when the fast path breaks. */
  agentFallback(kind: "search" | "availability", id: string, arg: string): { url: string; goal: string; output_schema: Record<string, unknown> };
}
