/**
 * Pure functions that turn validated BiblioCommons page data into Stacks'
 * public data model. No network, no side effects: easy to test with fixtures.
 */
import type { z } from "zod";
import { StacksError } from "../../core/errors.js";
import { cleanText, haversineKm, localNow, titleCase, toMinutes, type Day } from "../../core/text.js";
import type {
  AvailabilitySummary,
  Branch,
  BranchAvailability,
  BranchSummary,
  Copy,
  LibraryEvent,
  Title,
  TitleDetails,
} from "../../schemas.js";
import type { EventResult, LibraryInfo, SearchResult } from "../types.js";
import type {
  RawAvailability,
  RawBib,
  RawBibItem,
  RawEvent,
  RawEventsState,
  RawLocation,
  RawLocationsState,
  RawRecordState,
  RawSearchState,
  RawApp,
  RawLibrary,
  RawAvailabilityResponse,
  RawCatalogBib,
} from "./contracts.js";

const FORMAT_LABELS: Record<string, string> = {
  BK: "Book",
  EBOOK: "eBook",
  LPRINT: "Large Print",
  GRAPHIC_NOVEL: "Graphic Novel",
  PICTURE_BOOK: "Picture Book",
  EASY_READER: "Easy Reader",
  BOARD_BK: "Board Book",
  PAPERBACK: "Paperback",
  BOOK_CD: "Audiobook CD",
  EAUDIOBOOK: "Downloadable Audiobook",
  AB: "Audiobook",
  PLAYAWAY_AUDIOBOOK: "Preloaded Audiobook",
  RESTRICTED_BOOK_CD: "Talking Book CD",
  DAISY: "DAISY Talking Book",
  DVD: "DVD",
  BLURAY: "Blu-ray Disc",
  VIDEO_ONLINE: "Streaming Video",
  MUSIC_CD: "Music CD",
  MUSIC_ONLINE: "Streaming Music",
  LP: "Vinyl LP",
  MN: "Printed Music",
  MAG: "Magazine",
  MAG_ONLINE: "Online Magazine",
  EJ: "Online Journal",
  MF: "Microform",
  KIT: "Kit",
  VIDEO_GAME: "Video Game",
  WEBSITE: "Website",
  UK: "Unknown Format",
};

/** Friendly format names an agent can pass, mapped to platform codes. */
export const FORMAT_ALIASES: Record<string, string> = {
  book: "BK",
  ebook: "EBOOK",
  audiobook: "BOOK_CD",
  eaudiobook: "EAUDIOBOOK",
  large_print: "LPRINT",
  graphic_novel: "GRAPHIC_NOVEL",
  picture_book: "PICTURE_BOOK",
  dvd: "DVD",
  bluray: "BLURAY",
  music_cd: "MUSIC_CD",
  magazine: "MAG",
};

export function formatOf(code: string) {
  return { code, label: FORMAT_LABELS[code] ?? titleCase(code) };
}

const time = (t: string | null | undefined): string | null => (t ? t.replace(/^T/, "").slice(0, 5) : null);

export function libraryInfo(id: string, app: z.infer<typeof RawApp>, libraries: Record<string, z.infer<typeof RawLibrary>> | null | undefined): LibraryInfo {
  const lib = Object.values(libraries ?? {})[0];
  return {
    library_id: id,
    name: lib?.longName || lib?.shortName || id,
    catalog_url: app.baseURL || `https://${id}.bibliocommons.com`,
    home_url: lib?.homeLink || null,
    timezone: lib?.timezone || null,
    platform_version: app.coreVersion ?? null,
  };
}

export function summarize(a: RawAvailability | null | undefined): AvailabilitySummary {
  if (!a) return { status: "unknown", total_copies: null, available_copies: null, holds: null, on_order_copies: null };
  let total = a.totalCopies ?? null;
  let available = a.availableCopies ?? null;
  const onOrder = a.onOrderCopies ?? null;
  let status: AvailabilitySummary["status"];
  // The site calls a title "available" when the only copy in is for use inside the library.
  if (a.libraryUseOnly || /LIBRARY_USE_ONLY/.test(a.localisedStatus ?? "")) status = "library_use_only";
  else if (a.status === "AVAILABLE" || a.statusType === "AVAILABLE" || (available ?? 0) > 0) status = "available";
  else if ((total ?? 0) > 0) status = "all_copies_in_use";
  else if ((onOrder ?? 0) > 0) status = "on_order";
  else status = "unavailable";
  // "Available" with 0 of 0 copies means the site did not send counts with this result, not that there are none.
  if (status === "available" && !total && !available) {
    total = null;
    available = null;
  }
  return { status, total_copies: total, available_copies: available, holds: a.heldCopies ?? null, on_order_copies: onOrder };
}

function toTitle(bib: RawBib, base: string, others: RawBib[]): Title {
  const b = bib.briefInfo;
  const rating = b.rating && typeof b.rating.averageRating === "number" && (b.rating.totalCount ?? 0) > 0
    ? { average_out_of_5: Math.round((b.rating.averageRating / 20) * 100) / 100, count: b.rating.totalCount ?? 0 }
    : null;
  return {
    title_id: bib.id,
    title: b.title,
    subtitle: b.subtitle || null,
    authors: b.authors ?? [],
    format: formatOf(b.format),
    year: b.publicationDate || null,
    language: b.primaryLanguage || null,
    call_number: b.callNumber || null,
    series: (b.series ?? []).map((s) => s.name).filter((n): n is string => !!n),
    audience: (b.audiences ?? []).map((a) => a.toLowerCase()),
    rating,
    availability: summarize(bib.availability),
    other_formats: others.map((o) => ({
      title_id: o.id,
      format: formatOf(o.briefInfo.format),
      year: o.briefInfo.publicationDate || null,
      availability: summarize(o.availability),
    })),
    url: `${base}/v2/record/${bib.id}`,
  };
}

export function parseSearch(state: z.infer<typeof RawSearchState>, base: string): SearchResult {
  const cs = state.search.catalogSearch;
  const bibs = state.entities.bibs ?? {};
  const titles: Title[] = [];
  const missing: string[] = [];
  for (const group of cs.results) {
    const rep = bibs[group.representative];
    if (!rep) {
      missing.push(group.representative);
      continue;
    }
    const others = (group.manifestations ?? [])
      .filter((id) => id !== group.representative)
      .map((id) => bibs[id])
      .filter((b): b is RawBib => !!b);
    titles.push(toTitle(rep, base, others));
  }
  // A results list that points at records the page did not include means the
  // page structure changed. Do not return a quietly shortened list.
  if (missing.length) {
    throw new StacksError("SITE_CHANGED", `Search results reference ${missing.length} title(s) missing from the page data.`, {
      details: { contract: "search results", broken_fields: [`entities.bibs[${missing[0]}]: missing`] },
    });
  }
  return {
    total: cs.pagination.count,
    page: cs.pagination.page,
    pages: cs.pagination.pages,
    did_you_mean: cs.didYouMeanQuerySuggestion || null,
    titles,
  };
}

function fieldValues(bib: z.infer<typeof RawCatalogBib>, name: string, category?: string): string[] {
  const out: string[] = [];
  for (const group of bib.fields ?? []) {
    if (category && group.category !== category) continue;
    for (const item of group.items ?? []) {
      if (item.fieldName !== name) continue;
      for (const v of item.fieldValues ?? []) out.push(...(v.primary?.values ?? []));
    }
  }
  return [...new Set(out.map((v) => v.trim()).filter(Boolean))];
}

/** Catalogue ISBN fields carry notes and prices ("9780684830421 (hbk.) $25.00"): keep the number, once. */
export function cleanIsbns(raw: string[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    const m = value.replace(/[-\s](?=\d)/g, "").match(/\b(97[89]\d{10}|\d{9}[\dXx])\b/);
    if (m && !out.includes(m[1]!.toUpperCase())) out.push(m[1]!.toUpperCase());
  }
  return out;
}

export function parseRecord(state: z.infer<typeof RawRecordState>, titleId: string, base: string): TitleDetails {
  const cat = state.entities.catalogBibs?.[titleId] ?? Object.values(state.entities.catalogBibs ?? {})[0];
  if (!cat) throw new StacksError("NOT_FOUND", `No title with id ${titleId} at this library.`, { hint: "Get a valid title_id from search_catalog." });
  const bibs = state.entities.bibs ?? {};
  const self = bibs[cat.id];
  const others = Object.values(bibs).filter((b) => b.id !== cat.id);
  const base_title: Title = self
    ? toTitle(self, base, others)
    : {
        title_id: cat.id,
        title: cat.brief.title,
        subtitle: cat.brief.subTitle || null,
        authors: (cat.brief.creators ?? []).map((c) => c.fullName.replace(/,\s*$/, "")),
        format: formatOf(cat.brief.format),
        year: cat.brief.publicationDate || null,
        language: cat.brief.primaryLanguage || null,
        call_number: null,
        series: [],
        audience: [],
        rating: null,
        availability: summarize(null),
        other_formats: [],
        url: `${base}/v2/record/${cat.id}`,
      };
  return {
    ...base_title,
    description: cleanText(cat.brief.description ?? fieldValues(cat, "SUMMARY")[0]),
    contributors: (cat.brief.creators ?? []).map((c) => ({ name: c.fullName.replace(/,\s*$/, ""), roles: c.relationships ?? [] })),
    publisher: fieldValues(cat, "PUBLICATION", "DETAILS")[0] ?? fieldValues(cat, "PUBLICATION")[0] ?? null,
    physical_description: fieldValues(cat, "DESCRIPTION")[0] ?? null,
    isbns: cleanIsbns(fieldValues(cat, "ISBN").length ? fieldValues(cat, "ISBN") : (self?.briefInfo.isbns ?? [])),
    subjects: fieldValues(cat, "SUBJECT").slice(0, 12),
    genres: fieldValues(cat, "GENRE").slice(0, 8),
  };
}

function toCopy(item: RawBibItem): Copy {
  const a = item.availability;
  const label = a.libraryStatus && /[a-z]/.test(a.libraryStatus) ? a.libraryStatus : titleCase(a.libraryStatus || a.status);
  let status: Copy["status"];
  // Some libraries send only UNAVAILABLE plus their own wording ("Checked Out", "On Loan"),
  // so the wording is read when the status code does not say.
  const wording = (a.libraryStatus ?? "").toLowerCase();
  if (a.libraryUseOnly || a.status === "LIBRARY_USE_ONLY") status = "library_use_only";
  else if (a.status === "AVAILABLE") status = "on_shelf";
  else if (a.status === "CHECKED_OUT" || /\b(checked out|on loan|overdue)\b/.test(wording)) status = "checked_out";
  else if (/hold\s*shelf/.test(wording)) status = "on_hold_shelf";
  else if (a.status === "IN_TRANSIT" || /\b(transit|transferred)\b/.test(wording)) status = "in_transit";
  else if (a.status === "ON_ORDER" || /\bon order\b/.test(wording)) status = "on_order";
  else status = "unavailable";
  return { status, status_label: label, collection: item.collection || null, call_number: item.callNumber || null, due_date: item.dueDate || null };
}

export function parseAvailability(res: z.infer<typeof RawAvailabilityResponse>, titleId: string): { summary: AvailabilitySummary; branches: BranchAvailability[] } {
  const avail = res.entities.availabilities?.[titleId] ?? Object.values(res.entities.availabilities ?? {})[0];
  const byBranch = new Map<string, BranchAvailability>();
  for (const item of Object.values(res.entities.bibItems ?? {})) {
    const copy = toCopy(item);
    let b = byBranch.get(item.branch.code);
    if (!b) {
      b = { branch_code: item.branch.code, branch_name: item.branch.name.replace(/^[_\s]+/, ""), copies_total: 0, copies_on_shelf: 0, next_due_date: null, copies: [] };
      byBranch.set(item.branch.code, b);
    }
    b.copies.push(copy);
    b.copies_total++;
    if (copy.status === "on_shelf") b.copies_on_shelf++;
    if (copy.due_date && (!b.next_due_date || copy.due_date < b.next_due_date)) b.next_due_date = copy.due_date;
  }
  const branches = [...byBranch.values()].sort((x, y) => y.copies_on_shelf - x.copies_on_shelf || x.branch_name.localeCompare(y.branch_name));
  return { summary: summarize(avail), branches };
}

const DAY_ORDER: Day[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function toBranch(loc: RawLocation, state: z.infer<typeof RawLocationsState>, now: Date): Branch {
  const tz = loc.mapLocation?.timeZone ?? Object.values(state.entities.libraries ?? {})[0]?.timezone ?? null;
  const hours = DAY_ORDER.map((day) => {
    const ranges = (loc.hours ?? []).filter((h) => h.timeRef === day && h.openTime && h.closeTime);
    const open = ranges.map((r) => time(r.openTime)!).sort()[0] ?? null;
    const close = ranges.map((r) => time(r.closeTime)!).sort().at(-1) ?? null;
    return { day: day as Exclude<Day, never>, open, close };
  });

  const local = localNow(tz, now);
  const specials = Object.values(state.entities.specialHours ?? {}).filter(
    (s) => s.allLocations || (s.locationIds ?? []).includes(loc.id) || (loc.specialHoursIds ?? []).includes(s.id),
  );
  const regular = hours.find((h) => h.day === local.day) ?? { open: null, close: null };
  const special = specials.find((s) => s.startDate <= local.date && local.date <= s.endDate);
  const today = special
    ? special.openTime || special.closeTime
      ? { open: time(special.openTime) ?? regular.open, close: time(special.closeTime) ?? regular.close, note: special.name?.trim() || "Special hours" }
      : { open: null, close: null, note: `Closed: ${special.name?.trim() || "special closure"}` }
    : { open: regular.open, close: regular.close, note: null };
  const open_now = today.open && today.close ? local.minutes >= toMinutes(today.open) && local.minutes < toMinutes(today.close) : false;

  const facilityTypes = state.entities.facilityTypes ?? {};
  const a = loc.address;
  const point = loc.mapLocation?.centrePoint ?? null;
  return {
    branch_code: loc.id,
    name: loc.name,
    address: a ? [a.number, a.street].filter(Boolean).join(" ") || null : null,
    city: a?.city || null,
    postal_code: a?.zip || null,
    phone: (loc.branchContacts ?? []).find((c) => c.contactType === "phone")?.value || null,
    latitude: point?.lat ?? null,
    longitude: point?.lng ?? null,
    distance_km: null,
    open_now: tz ? open_now : null,
    today,
    timezone: tz,
    hours,
    upcoming_closures: specials
      .filter((s) => s.endDate >= local.date)
      .sort((x, y) => x.startDate.localeCompare(y.startDate))
      .slice(0, 8)
      .map((s) => ({ name: s.name?.trim() || "Special hours", start_date: s.startDate, end_date: s.endDate, open: time(s.openTime), close: time(s.closeTime) })),
    services: [...new Set((loc.facilities ?? []).map((f) => facilityTypes[f.typeId]).filter((t) => t && !t.isHidden).map((t) => t!.label))].sort(),
    highlights: (loc.highlights ?? []).map((h) => h.label).filter((l): l is string => !!l),
    accessibility: cleanText(loc.accessibilityInfo),
    parking: cleanText(loc.directionsAndParking),
    directions: cleanText(loc.directions),
    url: loc.webUrl || null,
  };
}

export function parseBranches(state: z.infer<typeof RawLocationsState>, now = new Date()): Branch[] {
  const order = state.locations.locationsSearch.results;
  const locs = state.entities.locations;
  const ids = order.length ? order : Object.keys(locs);
  return ids
    .map((id) => locs[id])
    .filter((l): l is RawLocation => !!l && !l.isHidden)
    .map((l) => toBranch(l, state, now));
}

export function summarizeBranch(b: Branch, from?: { lat: number; lng: number }): BranchSummary {
  const distance = from && b.latitude !== null && b.longitude !== null ? Math.round(haversineKm(from, { lat: b.latitude, lng: b.longitude }) * 10) / 10 : null;
  return {
    branch_code: b.branch_code,
    name: b.name,
    address: b.address,
    city: b.city,
    postal_code: b.postal_code,
    phone: b.phone,
    latitude: b.latitude,
    longitude: b.longitude,
    distance_km: distance,
    open_now: b.open_now,
    today: b.today,
  };
}

function toEvent(ev: RawEvent, state: z.infer<typeof RawEventsState>, base: string): LibraryEvent {
  const d = ev.definition;
  const names = (ids: string[] | null | undefined, table: Record<string, { name: string }> | null | undefined) =>
    (ids ?? []).map((id) => table?.[id]?.name).filter((n): n is string => !!n);
  const branch = d.branchLocationId ? state.entities.locations?.[d.branchLocationId] : undefined;
  // Sign-up runs through the library's own system (BIBLIO_EVENTS) or an outside organiser (EXTERNAL).
  const reg = d.registrationInfo;
  const registrationRequired = (reg?.enabledMethods ?? []).length > 0 || reg?.provider === "BIBLIO_EVENTS" || reg?.provider === "EXTERNAL";
  return {
    event_id: ev.id,
    title: d.title.trim(),
    start: d.start,
    end: d.end || null,
    all_day: !d.start.includes("T"),
    branch_code: d.branchLocationId || null,
    branch_name: branch?.name ?? null,
    room: cleanText(d.locationDetails, 200),
    is_online: !d.branchLocationId,
    description: cleanText(d.description, 700),
    audiences: names(d.audienceIds, state.entities.eventAudiences),
    types: names(d.typeIds, state.entities.eventTypes),
    languages: names(d.languageIds, state.entities.eventLanguages),
    registration_required: registrationRequired,
    registration_closed: !!ev.registrationClosed || (registrationRequired && ev.registrationWindow?.status === "ENDED"),
    is_full: !!ev.isFull,
    is_cancelled: !!d.isCancelled,
    is_recurring: !!ev.isRecurring,
    url: `${base}/events/${ev.id}`,
  };
}

export function parseEvents(state: z.infer<typeof RawEventsState>, base: string): EventResult {
  const es = state.events.eventsSearch;
  const table = state.entities.events ?? {};
  const events: LibraryEvent[] = [];
  const missing: string[] = [];
  for (const id of es.results) {
    const ev = table[id];
    if (ev) events.push(toEvent(ev, state, base));
    else missing.push(id);
  }
  if (missing.length) {
    throw new StacksError("SITE_CHANGED", `Event results reference ${missing.length} event(s) missing from the page data.`, {
      details: { contract: "event results", broken_fields: [`entities.events[${missing[0]}]: missing`] },
    });
  }
  return { total: es.pagination.count, page: es.pagination.page, pages: es.pagination.pages, events, filters: { audiences: [], event_types: [] } };
}
