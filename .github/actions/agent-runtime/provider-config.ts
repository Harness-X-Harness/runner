import * as fs from "node:fs/promises";
import path from "node:path";
import { AGENT_MODEL_DEFAULTS, type AgentSelection } from "./agent-model.ts";
import { TaskError } from "../../../shared/task-errors.ts";

export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete child.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete child.GITHUB_TOKEN;
  return child;
}

export async function configureProvider(executor: "codex" | "grok", env: NodeJS.ProcessEnv,
  selection: AgentSelection = AGENT_MODEL_DEFAULTS[executor]): Promise<void> {
  const codex = executor === "codex";
  const endpoint = env[codex ? "MINI_CODEX_BASE_URL" : "MINI_GROK_BASE_URL"];
  if (!env.MINI_END_USER_KEY || !endpoint || !env.HOME || !path.isAbsolute(env.HOME)) {
    throw new TaskError("PROVIDER_UNAVAILABLE");
  }
  const directory = path.join(env.HOME, codex ? ".codex" : ".grok");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const baseUrl = JSON.stringify(endpoint);
  const model = JSON.stringify(selection.model);
  const effort = JSON.stringify(selection.reasoningEffort);
  const config = codex
    ? `model = ${model}
model_reasoning_effort = ${effort}
model_provider = "mini_codex"
[model_providers.mini_codex]
name = "Mini Codex"
base_url = ${baseUrl}
wire_api = "responses"
env_key = "MINI_END_USER_KEY"
`
    : `[models]
default = ${model}
default_reasoning_effort = ${effort}
[endpoints]
models_base_url = ${baseUrl}
[model.${model}]
env_key = "MINI_END_USER_KEY"
`;
  const file = path.join(directory, "config.toml");
  await fs.writeFile(file, config, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
