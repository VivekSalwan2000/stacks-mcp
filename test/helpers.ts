import { readFileSync } from "node:fs";
import type { AgentRun, Endpoint, FetchedPage, PageRead, ReadPageOptions, SearchHit, Watch, WatchSpec, Web } from "../src/core/web.js";

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

/** A Web that serves recorded pages instead of calling TinyFish. */
export class FakeWeb implements Web {
  usage: Record<Endpoint, number> = { search: 0, fetch: 0, browser: 0, agent: 0, monitor: 0 };
  pages = new Map<string, Partial<PageRead>>();
  agentRuns: Array<{ url: string; goal: string }> = [];

  /** Serve `state` (and optional captured responses) for any URL containing `match`. */
  serve(match: string, state: unknown, captured: Record<string, unknown> = {}, status = 200) {
    this.pages.set(match, { state, captured, status });
  }

  async readPage(url: string, opts: ReadPageOptions): Promise<PageRead> {
    this.usage.browser++;
    const hit = [...this.pages.entries()].filter(([m]) => url.includes(m)).sort((a, b) => b[0].length - a[0].length)[0];
    const page = hit?.[1] ?? { state: null, status: 404 };
    const state = page.state ?? null;
    const captured = state !== null && (opts.shouldCapture?.(state) ?? true) ? (page.captured ?? {}) : {};
    return { status: page.status ?? 200, finalUrl: url, state, captured, ms: 1, via: "direct" };
  }

  async search(): Promise<SearchHit[]> {
    this.usage.search++;
    return [];
  }
  async fetch(urls: string[]): Promise<FetchedPage[]> {
    this.usage.fetch++;
    return urls.map((url) => ({ url, final_url: url, title: null, text: null }));
  }
  async agentStart(p: { url: string; goal: string }): Promise<string> {
    this.usage.agent++;
    this.agentRuns.push(p);
    return "00000000-0000-4000-8000-000000000001";
  }
  async agentGet(runId: string): Promise<AgentRun> {
    return { run_id: runId, status: "RUNNING", result: null, error: null, steps: null };
  }
  async agentWait(runId: string): Promise<AgentRun> {
    return this.agentGet(runId);
  }
  async watchCreate(_spec: WatchSpec): Promise<{ watch: Watch; baselineText: string | null }> {
    throw new Error("not implemented");
  }
  async watchList(): Promise<Watch[]> {
    return [];
  }
  async watchRunNow(): Promise<{ text: string | null }> {
    return { text: null };
  }
  async watchCancel(): Promise<void> {}
  async close(): Promise<void> {}
}

export const TEST_CONFIG = { apiKey: "test", proxy: "off", agentWaitMs: 10, port: 0 };
