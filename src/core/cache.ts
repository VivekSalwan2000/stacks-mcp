/** Small in-memory TTL cache with in-flight de-duplication. */
export class TtlCache {
  private store = new Map<string, { value: unknown; expires: number }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private maxEntries = 300) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set(key: string, value: unknown, ttlMs: number) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  /** Return a cached value, or compute it once even under concurrent callers. */
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return { value: hit, cached: true };
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return { value: await pending, cached: true };
    const p = compute();
    this.inflight.set(key, p);
    try {
      const value = await p;
      this.set(key, value, ttlMs);
      return { value, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  clear() {
    this.store.clear();
  }
}

export const TTL = {
  availability: 5 * 60_000,
  search: 10 * 60_000,
  events: 30 * 60_000,
  branches: 60 * 60_000,
  library: 24 * 60 * 60_000,
} as const;

/** Polite pacing: at most one request to a given host every `minGapMs`. */
export class HostLimiter {
  private next = new Map<string, number>();
  constructor(private minGapMs = 750) {}

  async wait(url: string) {
    const host = new URL(url).host;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.minGapMs);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}
