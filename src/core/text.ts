const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

/** Turn site HTML (often double-escaped) into clean plain text. */
export function cleanText(input: string | null | undefined, maxLength = 1200): string | null {
  if (!input) return null;
  let s = decodeEntities(input);
  s = s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!s) return null;
  return s.length > maxLength ? `${s.slice(0, maxLength - 1).trimEnd()}…` : s;
}

export function titleCase(code: string): string {
  return code
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Case- and punctuation-insensitive form for matching user input to site labels. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const GENERIC = new Set(["branch", "library", "libraries", "public", "the", "of", "and", "community", "centre", "center"]);

function tokens(s: string): string[] {
  return norm(s).split(" ").filter((w) => w && !GENERIC.has(w));
}

/**
 * Find the best label match for what a user (or another tool) typed.
 * Tries exact, prefix and substring matches, then compares significant words,
 * so "_Central Branch" finds "Central Library".
 */
export function matchLabel<T>(input: string, items: T[], labels: (item: T) => string[]): T | undefined {
  const q = norm(input);
  if (!q) return undefined;
  const scored = items.map((item) => ({ item, labels: labels(item).map(norm), raw: labels(item) }));
  const direct =
    scored.find((s) => s.labels.includes(q)) ??
    scored.find((s) => s.labels.some((l) => l.startsWith(q))) ??
    scored.find((s) => s.labels.some((l) => l.includes(q)));
  if (direct) return direct.item;

  const want = tokens(input);
  if (!want.length) return undefined;
  let best: { item: T; score: number } | undefined;
  for (const s of scored) {
    for (const label of s.raw) {
      const have = tokens(label);
      if (!have.length) continue;
      const [small, large] = want.length <= have.length ? [want, have] : [have, want];
      if (!small.every((w) => large.includes(w))) continue;
      const score = small.length / large.length;
      if (!best || score > best.score) best = { item: s.item, score };
    }
  }
  return best?.item;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export type Day = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

/** The current date, weekday and minutes-past-midnight in a given IANA time zone. */
export function localNow(timeZone: string | null, now = new Date()): { date: string; day: Day; minutes: number } {
  const fmt = (tz: string | undefined) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long", hourCycle: "h23" });
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(timeZone ?? undefined).formatToParts(now);
  } catch {
    parts = fmt(undefined).formatToParts(now);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").toLowerCase() as Day;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** The host of a URL, or null if the text is not a URL. Search results are not always well formed. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
