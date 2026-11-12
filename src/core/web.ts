/**
 * The web engine. Every network call Stacks makes goes through here, and
 * every one of them is a TinyFish endpoint:
 *
 *   Search   find pages on the open web
 *   Fetch    read a page as clean text (fast, cheap)
 *   Browser  drive a real remote browser over CDP (JS-rendered data)
 *   Agent    a goal-driven agent that navigates and reasons (slow, flexible)
 *   Monitor  scheduled re-checks of a page with change detection
 *
 * Adapters depend on the `Web` interface, not on TinyFish directly, so they
 * can be unit-tested offline with recorded fixtures.
 */
import { TinyFish } from "@tiny-fish/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { HostLimiter } from "./cache.js";
import type { Config } from "./config.js";
import { StacksError, toStacksError } from "./errors.js";

export type Endpoint = "search" | "fetch" | "browser" | "agent" | "monitor";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  site_name?: string;
}

export interface FetchedPage {
  url: string;
  final_url: string | null;
  title: string | null;
  text: string | null;
  error?: string;
}

export interface PageRead {
  status: number;
  finalUrl: string;
  /** JSON parsed from the element matched by `stateSelector`, or null if absent. */
  state: unknown | null;
  /** JSON bodies of the page's own background requests, keyed by capture name. */
  captured: Record<string, unknown>;
  ms: number;
  via: "direct" | "proxy";
}

export interface ReadPageOptions {
  /** CSS selector of a <script> holding the page's server-rendered JSON state. */
  stateSelector: string;
  /** Background responses to capture while the page loads (name -> URL pattern). */
  capture?: Record<string, RegExp>;
  captureTimeoutMs?: number;
  /** Skip waiting for captures when the page state shows they will never arrive (e.g. a not-found page). */
  shouldCapture?: (state: unknown) => boolean;
}

export interface AgentRun {
  run_id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  result: Record<string, unknown> | null;
  error: string | null;
  steps: number | null;
}

export interface WatchSpec {
  name: string;
  url: string;
  schedule_cron: string;
  purpose: string;
  webhook_url?: string;
}

export interface Watch {
  id: string;
  name: string | null;
  url: string | null;
  schedule_cron: string;
  status: string;
  last_error: string | null;
  webhook_url: string | null;
  created_at: string;
}

export interface Web {
  search(query: string, opts?: { include_domains?: string }): Promise<SearchHit[]>;
  fetch(urls: string[]): Promise<FetchedPage[]>;
  readPage(url: string, opts: ReadPageOptions): Promise<PageRead>;
  agentStart(params: { url: string; goal: string; output_schema?: Record<string, unknown> }): Promise<string>;
  agentGet(runId: string): Promise<AgentRun>;
  agentWait(runId: string, budgetMs: number): Promise<AgentRun>;
  watchCreate(spec: WatchSpec): Promise<{ watch: Watch; baselineText: string | null }>;
  watchList(): Promise<Watch[]>;
  watchRunNow(id: string): Promise<{ text: string | null }>;
  watchCancel(id: string): Promise<void>;
  /** How many calls each TinyFish endpoint has served in this process. */
  usage: Record<Endpoint, number>;
  close(): Promise<void>;
}

const BLOCKED_RESOURCES = new Set(["image", "font", "media", "stylesheet"]);
const IDLE_CLOSE_MS = 90_000;
/** A remote session is replaced after this long, before the service retires it under us. */
const MAX_SESSION_AGE_MS = 4 * 60_000;
/** Nothing a page read does may take longer than this: a dead session must fail, not hang. */
const PAGE_DEADLINE_MS = 80_000;

class PageDeadline extends Error {
  override name = "TimeoutError";
}

/** One warm remote browser, reused across calls and closed when idle. */
class BrowserPool {
  private browser?: Browser;
  private opening?: Promise<Browser>;
  private idle?: NodeJS.Timeout;
  private openedAt = 0;
  private inFlight = 0;

  constructor(
    private client: TinyFish,
    private proxy: { enabled: boolean; country?: string },
  ) {}

  private async open(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      const stale = Date.now() - this.openedAt > MAX_SESSION_AGE_MS;
      if (!stale || this.inFlight > 0) return this.browser;
      this.discard();
    }
    this.opening ??= (async () => {
      const session = await this.client.browser.sessions.create({
        proxy_config: this.proxy.enabled
          ? { enabled: true, type: "tinyfish", ...(this.proxy.country ? { country_code: this.proxy.country } : {}) }
          : { enabled: false },
      });
      const browser = await chromium.connectOverCDP(session.cdp_url, { timeout: 30_000 });
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
      });
      this.browser = browser;
      this.openedAt = Date.now();
      return browser;
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /** Drop the current session without waiting on it: it may be the thing that is stuck. */
  private discard() {
    const b = this.browser;
    this.browser = undefined;
    void b?.close().catch(() => {});
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.idle) clearTimeout(this.idle);
    let attempt = 0;
    for (;;) {
      const browser = await this.open();
      let page: Page | undefined;
      let timer: NodeJS.Timeout | undefined;
      this.inFlight++;
      try {
        const work = (async () => {
          const context = browser.contexts()[0] ?? (await browser.newContext());
          page = await context.newPage();
          await page.route("**/*", (route) =>
            BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
          );
          return fn(page);
        })();
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PageDeadline(`Timed out: the remote browser did not answer within ${PAGE_DEADLINE_MS / 1000} s`)), PAGE_DEADLINE_MS);
        });
        work.catch(() => {}); // if the deadline wins, the abandoned work must not become an unhandled rejection
        return await Promise.race([work, deadline]);
      } catch (err) {
        if (err instanceof PageDeadline) {
          // The session is stuck. Replace it for the next call; do not make this caller wait again.
          if (this.browser === browser) this.discard();
          throw err;
        }
        // A navigation timeout or a typed error is the page's answer. Anything else is
        // treated as a broken session and tried once more on a fresh one.
        const pageAnswered = err instanceof StacksError || (err as Error)?.name === "TimeoutError";
        if (!pageAnswered && attempt++ < 1) {
          if (this.browser === browser) this.discard();
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        this.inFlight--;
        void (page as Page | undefined)?.close().catch(() => {});
        if (this.idle) clearTimeout(this.idle);
        this.idle = setTimeout(() => {
          if (this.inFlight === 0) void this.close();
        }, IDLE_CLOSE_MS);
        this.idle.unref();
      }
    }
  }

  async close() {
    if (this.idle) clearTimeout(this.idle);
    const b = this.browser;
    this.browser = undefined;
    await b?.close().catch(() => {});
  }
}

export class TinyFishWeb implements Web {
  readonly usage: Record<Endpoint, number> = { search: 0, fetch: 0, browser: 0, agent: 0, monitor: 0 };
  private client: TinyFish;
  private direct: BrowserPool;
  private proxied: BrowserPool;
  private limiter = new HostLimiter();
  private needsProxy = new Set<string>();

  constructor(private config: Config) {
    this.client = new TinyFish({ apiKey: config.apiKey });
    const country = /^[A-Za-z]{2}$/.test(config.proxy) ? config.proxy.toUpperCase() : undefined;
    this.direct = new BrowserPool(this.client, { enabled: false });
    this.proxied = new BrowserPool(this.client, { enabled: true, country });
  }

  async search(query: string, opts: { include_domains?: string } = {}): Promise<SearchHit[]> {
    this.usage.search++;
    try {
      const res = await this.client.search.query({ query, ...(opts.include_domains ? { include_domains: opts.include_domains } : {}) });
      return (res.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? "", site_name: r.site_name }));
    } catch (err) {
      throw toStacksError(err);
    }
  }

  async fetch(urls: string[]): Promise<FetchedPage[]> {
    if (!urls.length) return [];
    this.usage.fetch++;
    try {
      const res = await this.client.fetch.getContents({ urls, format: "markdown" });
      const pages: FetchedPage[] = (res.results ?? []).map((r) => ({
        url: r.url,
        final_url: r.final_url ?? null,
        title: r.title ?? null,
        text: typeof r.text === "string" ? r.text : null,
      }));
      for (const e of res.errors ?? []) pages.push({ url: e.url, final_url: null, title: null, text: null, error: e.error });
      return pages;
    } catch (err) {
      throw toStacksError(err);
    }
  }

  async readPage(url: string, opts: ReadPageOptions): Promise<PageRead> {
    const host = new URL(url).host;
    const mode = this.config.proxy.toLowerCase();
    const forceProxy = mode !== "off" && mode !== "auto";
    const first = forceProxy || this.needsProxy.has(host) ? "proxy" : "direct";
    let read = await this.readOnce(url, opts, first);
    if (first === "direct" && mode === "auto" && (read.status === 403 || read.status === 429) && read.state === null) {
      read = await this.readOnce(url, opts, "proxy");
      if (read.state !== null) this.needsProxy.add(host);
    }
    return read;
  }

  private async readOnce(url: string, opts: ReadPageOptions, via: "direct" | "proxy"): Promise<PageRead> {
    await this.limiter.wait(url);
    this.usage.browser++;
    const pool = via === "proxy" ? this.proxied : this.direct;
    const started = Date.now();
    try {
      return await pool.withPage(async (page) => {
        const captures = Object.entries(opts.capture ?? {}).map(([name, pattern]) => ({
          name,
          promise: page
            .waitForResponse((r) => pattern.test(r.url()) && r.request().method() === "GET", { timeout: opts.captureTimeoutMs ?? 20_000 })
            .then((r) => r.json() as Promise<unknown>)
            .catch(() => undefined),
        }));
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        const status = response?.status() ?? 0;
        const raw = await page.$eval(opts.stateSelector, (el) => el.textContent).catch(() => null);
        let state: unknown | null = null;
        if (raw) {
          try {
            state = JSON.parse(raw);
          } catch {
            state = null;
          }
        }
        const captured: Record<string, unknown> = {};
        if (status < 400 && state !== null && (opts.shouldCapture?.(state) ?? true)) {
          for (const c of captures) {
            const body = await c.promise;
            if (body !== undefined) captured[c.name] = body;
          }
        }
        return { status, finalUrl: page.url(), state, captured, ms: Date.now() - started, via };
      });
    } catch (err) {
      throw toStacksError(err);
    }
  }

  async agentStart(params: { url: string; goal: string; output_schema?: Record<string, unknown> }): Promise<string> {
    this.usage.agent++;
    try {
      const res = await this.client.agent.queue({
        url: params.url,
        goal: params.goal,
        ...(params.output_schema ? { output_schema: params.output_schema } : {}),
      });
      if (!res.run_id) throw new StacksError("TINYFISH_ERROR", `TinyFish Agent refused the run: ${res.error?.message ?? "unknown error"}`);
      return res.run_id;
    } catch (err) {
      throw toStacksError(err);
    }
  }

  async agentGet(runId: string): Promise<AgentRun> {
    try {
      const run = await this.client.runs.get(runId);
      return { run_id: run.run_id, status: run.status, result: run.result ?? null, error: run.error?.message ?? null, steps: run.num_of_steps ?? null };
    } catch (err) {
      const e = toStacksError(err);
      if ((err as { status?: number })?.status === 404 || /not found/i.test((err as Error)?.message ?? "")) {
        throw new StacksError("NOT_FOUND", `No Agent run with id ${runId}.`, { hint: "Use the job_id exactly as a Stacks tool returned it. Runs are kept by TinyFish for a limited time." });
      }
      throw e;
    }
  }

  async agentWait(runId: string, budgetMs: number): Promise<AgentRun> {
    const deadline = Date.now() + budgetMs;
    let run = await this.agentGet(runId);
    while ((run.status === "PENDING" || run.status === "RUNNING") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      run = await this.agentGet(runId);
    }
    return run;
  }

  async watchCreate(spec: WatchSpec): Promise<{ watch: Watch; baselineText: string | null }> {
    this.usage.monitor++;
    try {
      const res = await this.client.monitors.create({
        type: "fetch",
        name: spec.name,
        config: { url: spec.url, format: "markdown" },
        schedule_cron: spec.schedule_cron,
        purpose: spec.purpose,
        ...(spec.webhook_url ? { webhook_url: spec.webhook_url } : {}),
      });
      return { watch: toWatch(res.monitor), baselineText: runText(res.run) };
    } catch (err) {
      throw toStacksError(err);
    }
  }

  async watchList(): Promise<Watch[]> {
    this.usage.monitor++;
    try {
      const res = await this.client.monitors.list();
      return res.monitors.map(toWatch);
    } catch (err) {
      throw toStacksError(err);
    }
  }

  async watchRunNow(id: string): Promise<{ text: string | null }> {
    this.usage.monitor++;
    try {
      const res = await this.client.monitors.run(id);
      return { text: runText(res.run) };
    } catch (err) {
      if ((err as { status?: number })?.status === 404) throw new StacksError("NOT_FOUND", `No watch with id ${id}.`);
      throw toStacksError(err);
    }
  }

  async watchCancel(id: string): Promise<void> {
    this.usage.monitor++;
    try {
      await this.client.monitors.cancel(id);
    } catch (err) {
      if ((err as { status?: number })?.status === 404) throw new StacksError("NOT_FOUND", `No watch with id ${id}.`);
      throw toStacksError(err);
    }
  }

  async close() {
    await Promise.all([this.direct.close(), this.proxied.close()]);
  }
}

function toWatch(m: {
  id: string;
  name: string | null;
  schedule_cron: string;
  status: string;
  last_error: string | null;
  webhook_url: string | null;
  created_at: string;
  type: string;
  config: Record<string, unknown>;
}): Watch {
  return {
    id: m.id,
    name: m.name,
    url: typeof m.config.url === "string" ? m.config.url : null,
    schedule_cron: m.schedule_cron,
    status: m.status,
    last_error: m.last_error,
    webhook_url: m.webhook_url,
    created_at: m.created_at,
  };
}

function runText(run: unknown): string | null {
  const results = (run as { results?: Array<{ text?: unknown }> } | undefined)?.results;
  const text = results?.[0]?.text;
  return typeof text === "string" ? text : null;
}
