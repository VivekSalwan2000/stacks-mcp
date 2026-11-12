/**
 * The built-in directory of BiblioCommons libraries. Every entry was checked
 * live with TinyFish Fetch by `npm run refresh-registry`.
 */
import { norm } from "../../core/text.js";
import registry from "./registry.json" with { type: "json" };

export interface RegistryEntry {
  id: string;
  name: string;
  city: string | null;
  region: string | null;
  country: string | null;
}

export const REGISTRY: RegistryEntry[] = registry;

const byId = new Map(REGISTRY.map((e) => [e.id, e]));

export function registryGet(id: string): RegistryEntry | undefined {
  return byId.get(id.toLowerCase());
}

/** Rank directory entries against free text such as "Toronto", "seattle public library" or "vpl". */
export function registrySearch(query: string): RegistryEntry[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(" ").filter((w) => !["public", "library", "libraries", "the", "of", "county", "city"].includes(w));
  const scored = REGISTRY.map((e) => {
    const name = norm(e.name);
    const city = norm(e.city ?? "");
    let score = 0;
    if (e.id === q.replace(/ /g, "")) score = 100;
    else if (name === q) score = 95;
    else if (city && city === q) score = 90;
    else if (name.includes(q)) score = 80;
    else if (words.length && words.every((w) => name.split(" ").includes(w) || city.split(" ").includes(w))) score = 70;
    else if (words.length && words.some((w) => w.length > 3 && (name.split(" ").includes(w) || city.split(" ").includes(w)))) score = 40;
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    .map((s) => s.e);
}
