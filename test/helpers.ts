import { readFileSync } from "node:fs";
import type { AgentRun, Endpoint, FetchedPage, PageRead, ReadPageOptions, SearchHit, Watch, WatchSpec, Web } from "../src/core/web.js";

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

/** A Web that serves recorded pages instead of calling TinyFish. */
export class FakeWeb implements Web {
  usage: Record<Endpoint, number> = { search: 0, fetch: 0, browser: 0, agent: 0, monitor: 0 };
  pages = new Map<string, Partial<PageRead>>();
  agentRuns: Array<{ url: string; goal: string; output_schema?: Record<string, unknown> }> = [];
  /** If set, agentStart rejects with this message, like TinyFish refusing a run. */
  agentStartError: string | null = null;
  private blanks = new Map<string, number>();

  /** Serve `state` (and optional captured responses) for any URL containing `match`. */
  serve(match: string, state: unknown, captured: Record<string, unknown> = {}, status = 200, finalUrl?: string) {
    this.pages.set(match, { state, captured, status, finalUrl });
  }

  /** Make the next `times` reads of a URL containing `match` load without their data. */
  blankFirst(match: string, times: number) {
    this.blanks.set(match, times);
  }

  async readPage(url: string, opts: ReadPageOptions): Promise<PageRead> {
    this.usage.browser++;
    const hit = [...this.pages.entries()].filter(([m]) => url.includes(m)).sort((a, b) => b[0].length - a[0].length)[0];
    const page = hit?.[1] ?? { state: null, status: 404 };
    const blank = [...this.blanks.entries()].find(([m, n]) => url.includes(m) && n > 0);
    if (blank) {
      this.blanks.set(blank[0], blank[1] - 1);
      return { status: 200, finalUrl: url, state: null, captured: {}, ms: 1, via: "direct" };
    }
    const state = page.state ?? null;
    const captured = state !== null && (opts.shouldCapture?.(state) ?? true) ? (page.captured ?? {}) : {};
    return { status: page.status ?? 200, finalUrl: page.finalUrl ?? url, state, captured, ms: 1, via: "direct" };
  }

  async search(): Promise<SearchHit[]> {
    this.usage.search++;
    return [];
  }
  async fetch(urls: string[]): Promise<FetchedPage[]> {
    this.usage.fetch++;
    return urls.map((url) => ({ url, final_url: url, title: null, text: null }));
  }
  async agentStart(p: { url: string; goal: string; output_schema?: Record<string, unknown> }): Promise<string> {
    this.usage.agent++;
    if (this.agentStartError) throw new Error(this.agentStartError);
    this.agentRuns.push(p);
    return "00000000-0000-4000-8000-000000000001";
  }
  async agentGet(runId: string): Promise<AgentRun> {
    return { run_id: runId, status: "RUNNING", result: null, error: null, steps: null };
  }
  async agentWait(runId: string): Promise<AgentRun> {
    return this.agentGet(runId);
  }
  watches: Watch[] = [];
  async watchCreate(spec: WatchSpec): Promise<{ watch: Watch; baselineText: string | null }> {
    this.usage.monitor++;
    const watch: Watch = { id: `watch-${this.watches.length + 1}`, name: spec.name, url: spec.url, schedule_cron: spec.schedule_cron, status: "active", last_error: null, webhook_url: spec.webhook_url ?? null, created_at: "2026-11-12 00:00:00" };
    this.watches.push(watch);
    return { watch, baselineText: null };
  }
  async watchList(): Promise<Watch[]> {
    return this.watches;
  }
  async watchRunNow(): Promise<{ text: string | null }> {
    return { text: null };
  }
  async watchCancel(id: string): Promise<void> {
    this.watches = this.watches.filter((w) => w.id !== id);
  }
  async close(): Promise<void> {}
}

export const TEST_CONFIG = { apiKey: "test", proxy: "off", agentWaitMs: 10, port: 0 };
