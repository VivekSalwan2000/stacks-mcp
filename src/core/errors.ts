import type { z } from "zod";

/**
 * Every failure a Stacks tool can report. Tools never fail silently and never
 * return an empty result to hide a problem: they throw one of these.
 */
export const ERROR_CODES = {
  INVALID_INPUT: "The arguments were wrong. Fix them and call again.",
  UNKNOWN_LIBRARY: "No such library on this platform. Use find_library first.",
  NOT_FOUND: "The library has no record of that title, branch or event.",
  NOT_SUPPORTED: "This library does not run that part of the platform.",
  SITE_CHANGED: "The website no longer matches the contract Stacks expects. The tool is broken until it is updated.",
  SITE_UNAVAILABLE: "The library website returned a server error. It may be down; try again later.",
  SITE_BLOCKED: "The website refused the request (bot protection or geo-block).",
  UPSTREAM_TIMEOUT: "The website or TinyFish took too long.",
  RATE_LIMITED: "Too many requests. Wait and retry.",
  TINYFISH_ERROR: "TinyFish returned an error.",
  CONFIG_ERROR: "Stacks is not configured correctly.",
  JOB_FAILED: "A background Agent run failed.",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetails {
  tool?: string;
  url?: string;
  /** For SITE_CHANGED: which fields of the expected contract are missing or wrong. */
  broken_fields?: string[];
  /** For SITE_CHANGED: what kind of page data failed validation. */
  contract?: string;
  /** If a slower Agent run was queued to still get an answer. */
  fallback_job_id?: string;
  [key: string]: unknown;
}

export class StacksError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly retryable: boolean;
  details: ErrorDetails;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; retryable?: boolean; details?: ErrorDetails; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "StacksError";
    this.code = code;
    this.hint = opts.hint ?? ERROR_CODES[code];
    this.retryable = opts.retryable ?? (code === "UPSTREAM_TIMEOUT" || code === "RATE_LIMITED" || code === "SITE_UNAVAILABLE");
    this.details = opts.details ?? {};
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        retryable: this.retryable,
        ...(Object.keys(this.details).length ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Validate data scraped from the site against the contract Stacks depends on.
 * A mismatch means the site changed: fail loudly, naming the exact fields.
 */
export function contract<T extends z.ZodType>(schema: T, data: unknown, ctx: { contract: string; url?: string }): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const broken = [...new Set(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`))].slice(0, 12);
  throw new StacksError(
    "SITE_CHANGED",
    `The site's ${ctx.contract} data no longer matches what Stacks expects (${broken.length} field problem${broken.length === 1 ? "" : "s"}).`,
    {
      hint: "The website changed. Run the health_check tool for a full report and open an issue at https://github.com/VivekSalwan2000/stacks-mcp/issues.",
      details: { contract: ctx.contract, url: ctx.url, broken_fields: broken },
    },
  );
}

/** A remote browser's CDP address identifies a live session. It must not travel in an error. */
export function redact(text: string): string {
  return text.replace(/\bwss?:\/\/[^\s"'<>]+/gi, "[remote browser address]");
}

export function toStacksError(err: unknown): StacksError {
  if (err instanceof StacksError) return err;
  const e = err as { name?: string; message?: string; status?: number };
  const msg = redact(e?.message ?? String(err));
  if (e?.name === "RateLimitError" || e?.status === 429) return new StacksError("RATE_LIMITED", `TinyFish rate limit: ${msg}`, { cause: err });
  if (e?.name === "AuthenticationError" || e?.status === 401)
    return new StacksError("CONFIG_ERROR", "TinyFish rejected the API key.", { hint: "Set a valid TINYFISH_API_KEY.", cause: err });
  if (e?.name === "PaymentRequiredError" || e?.status === 402)
    return new StacksError("TINYFISH_ERROR", "The TinyFish account is out of credits.", { hint: "Top up at https://agent.tinyfish.ai.", cause: err });
  if (e?.name === "TimeoutError" || e?.name === "APITimeoutError" || /timeout|timed out/i.test(msg))
    return new StacksError("UPSTREAM_TIMEOUT", `Timed out: ${msg.split("\n")[0]}`, { cause: err });
  if (e?.name?.startsWith("API") || typeof e?.status === "number")
    return new StacksError("TINYFISH_ERROR", `TinyFish error: ${msg}`, { retryable: (e.status ?? 500) >= 500, cause: err });
  return new StacksError("TINYFISH_ERROR", `Unexpected failure: ${msg.split("\n")[0]}`, { cause: err });
}
