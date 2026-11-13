import { StacksError } from "./errors.js";

export interface Config {
  apiKey: string;
  defaultLibrary?: string;
  /** off: direct. auto: direct, retry through a proxy if blocked. tinyfish / <country>: always proxy. */
  proxy: string;
  agentWaitMs: number;
  port: number;
  /** Write one JSON line per tool call to stderr. On unless STACKS_LOG is off. */
  log?: boolean;
}

function numberFrom(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new StacksError("CONFIG_ERROR", `${name} must be a whole number from ${min} to ${max}, not "${raw}".`, { hint: `Unset ${name} to use the default (${fallback}).` });
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.TINYFISH_API_KEY?.trim();
  if (!apiKey) {
    throw new StacksError("CONFIG_ERROR", "TINYFISH_API_KEY is not set.", {
      hint: "Create a key at https://agent.tinyfish.ai and pass it as the TINYFISH_API_KEY environment variable.",
    });
  }
  return {
    apiKey,
    defaultLibrary: env.STACKS_DEFAULT_LIBRARY?.trim().toLowerCase() || undefined,
    proxy: (env.STACKS_PROXY ?? "auto").trim(),
    agentWaitMs: numberFrom(env, "STACKS_AGENT_WAIT_MS", 40_000, 0, 600_000),
    port: numberFrom(env, "PORT", 3000, 0, 65_535),
    log: !["off", "0", "false", "no"].includes((env.STACKS_LOG ?? "").trim().toLowerCase()),
  };
}
