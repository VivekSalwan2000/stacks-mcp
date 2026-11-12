import { StacksError } from "./errors.js";

export interface Config {
  apiKey: string;
  defaultLibrary?: string;
  /** off: direct. auto: direct, retry through a proxy if blocked. tinyfish / <country>: always proxy. */
  proxy: string;
  agentWaitMs: number;
  port: number;
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
    agentWaitMs: Number(env.STACKS_AGENT_WAIT_MS ?? 40_000),
    port: Number(env.PORT ?? 3000),
  };
}
