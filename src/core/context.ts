import type { LibraryAdapter } from "../adapters/types.js";
import { BiblioCommonsAdapter } from "../adapters/bibliocommons/adapter.js";
import { registryGet, registrySearch } from "../adapters/bibliocommons/registry.js";
import { TtlCache } from "./cache.js";
import type { Config } from "./config.js";
import { StacksError } from "./errors.js";
import type { CallLog } from "./tool.js";
import { TinyFishWeb, type Web } from "./web.js";

/** Everything a tool needs. One per TinyFish API key. */
export interface Context {
  config: Config;
  web: Web;
  cache: TtlCache;
  adapter: LibraryAdapter;
  /** Where tool-call log lines go. Defaults to stderr; tests replace it. */
  log?: (entry: CallLog) => void;
}

export function createContext(config: Config, web: Web = new TinyFishWeb(config)): Context {
  const cache = new TtlCache();
  return { config, web, cache, adapter: new BiblioCommonsAdapter(web, cache) };
}

/**
 * Turn whatever the agent passed as `library` into a library id.
 * Accepts an id ("tpl"), or a name or city from the directory ("Toronto").
 */
export function resolveLibrary(ctx: Context, input: string | undefined): string {
  const raw = (input ?? ctx.config.defaultLibrary ?? "").trim();
  if (!raw) {
    throw new StacksError("INVALID_INPUT", "No library given.", {
      hint: "Pass `library` (e.g. \"tpl\"). Call find_library with a city or library name to get the id.",
    });
  }
  const id = raw.toLowerCase();
  if (registryGet(id)) return id;
  const byName = registrySearch(raw);
  if (byName.length === 1 || (byName.length > 1 && !ctx.adapter.validId(id))) return byName[0]!.id;
  if (ctx.adapter.validId(id)) return id;
  throw new StacksError("UNKNOWN_LIBRARY", `"${raw}" is not a known library.`, {
    hint: "Call find_library with a city or library name to get a valid library_id.",
  });
}
