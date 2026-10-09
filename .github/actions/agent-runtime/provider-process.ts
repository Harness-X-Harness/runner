import { fileURLToPath } from "node:url";
import type { AgentProcess } from "./acp-client.ts";

export function providerProcess(executor: "codex" | "grok", workspace: string,
  env: NodeJS.ProcessEnv): Omit<AgentProcess, "signal"> {
  return {
    command: executor === "codex" ? fileURLToPath(new URL("./node_modules/.bin/codex-acp", import.meta.url)) : "grok",
    args: executor === "codex" ? [] : ["--always-approve", "agent", "--no-leader", "stdio"],
    workspace,
    env: executor === "codex" ? { ...env, CODEX_PATH: "codex", INITIAL_AGENT_MODE: "agent-full-access", CODEX_CONFIG: JSON.stringify({
      sandbox_mode: "danger-full-access", approval_policy: "never",
      // ACP also merges feature flags; keep one nested table, not overlapping dotted keys.
      features: { default_mode_request_user_input: true },
    }) } : { ...env, XAI_API_KEY: env.MINI_END_USER_KEY },
    extensions: executor === "grok" ? "grok" : undefined,
  };
}
