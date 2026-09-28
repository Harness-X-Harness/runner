import * as fs from "node:fs/promises";
import path from "node:path";
import { AgentRuntime, type Executor, type RunInput, type RuntimeOptions } from "../agent-runtime/index.ts";
import { TASK_LIMITS, isTaskId, boundedTaskResult } from "../../../shared/task-contract.ts";
import { TaskError } from "../../../shared/task-errors.ts";
import { runnerIdentity } from "../runner-identity.ts";

type CallbackOptions = { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch; signal?: AbortSignal };
type Options = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };
type Claim = { taskId: string; executor: Executor; prompt: string };
type Outcome = { status: "completed"; result: ReturnType<typeof boundedTaskResult> } |
  { status: "failed"; error: ReturnType<TaskError["toJSON"]> };
type RuntimeFactory = (executor: Executor, options: RuntimeOptions) => {
  run(input: RunInput): Promise<{ finalResponse: string }>;
};

export function taskDirectory(env: NodeJS.ProcessEnv): string {
  if (!isTaskId(env.TASK_ID) || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) throw new TaskError("INVALID_TASK_INPUT");
  return path.join(env.RUNNER_TEMP, `harness-${env.TASK_ID}`);
}

function controlPlaneOrigin(env: NodeJS.ProcessEnv): string {
  const url = new URL(env.TASK_CONTROL_PLANE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new TaskError("INVALID_TASK_INPUT");
  }
  return url.origin;
}

async function privateJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function callback(phase: "claim" | "finish", payload: unknown, { env, fetchImpl, signal }: CallbackOptions): Promise<Response> {
  const origin = controlPlaneOrigin(env);
  const token = await runnerIdentity(origin, env, fetchImpl, signal);
  return fetchImpl(`${origin}/internal/tasks/${env.TASK_ID}/${phase}`, {
    method: "POST", signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function claim(value: unknown, taskId: string | undefined): Claim {
  if (!value || typeof value !== "object" || !("taskId" in value) ||
      !isTaskId(value.taskId) || value.taskId !== taskId || !("executor" in value) ||
      (value.executor !== "codex" && value.executor !== "grok") || !("prompt" in value) ||
      typeof value.prompt !== "string" || !value.prompt.trim() ||
      Buffer.byteLength(value.prompt) > TASK_LIMITS.promptBytes) throw new TaskError("CLAIM_REJECTED");
  return { taskId: value.taskId, executor: value.executor, prompt: value.prompt };
}

export async function claimTask({ env = process.env, fetchImpl = fetch }: Options = {}): Promise<void> {
  const directory = taskDirectory(env);
  const response = await callback("claim", {}, { env, fetchImpl });
  if (!response.ok) throw new TaskError("CLAIM_REJECTED");
  const task = claim(await response.json(), env.TASK_ID);
  if (!env.GITHUB_OUTPUT) throw new TaskError("INVALID_TASK_INPUT");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await privateJson(path.join(directory, "claim.json"), {
    taskId: task.taskId, executor: task.executor, prompt: task.prompt,
  });
  await fs.appendFile(env.GITHUB_OUTPUT, `executor=${task.executor}\n`);
}

export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete child.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete child.GITHUB_TOKEN;
  return child;
}

export async function configureProvider(executor: Executor, env: NodeJS.ProcessEnv): Promise<void> {
  const codex = executor === "codex";
  const endpoint = env[codex ? "MINI_CODEX_BASE_URL" : "MINI_GROK_BASE_URL"];
  if (!env.MINI_END_USER_KEY || !env.GH_TOKEN || !endpoint || !env.HOME || !path.isAbsolute(env.HOME)) {
    throw new TaskError("PROVIDER_UNAVAILABLE");
  }
  const directory = path.join(env.HOME, codex ? ".codex" : ".grok");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const baseUrl = JSON.stringify(endpoint);
  const config = codex
    ? `model = "gpt-5.6-sol"
model_provider = "mini_codex"
[model_providers.mini_codex]
name = "Mini Codex"
base_url = ${baseUrl}
wire_api = "responses"
env_key = "MINI_END_USER_KEY"
`
    : `[models]
default = "mini-grok-4-6"
[model.mini-grok-4-6]
model = "grok-4.6"
base_url = ${baseUrl}
name = "Mini Grok 4.6"
description = "Grok through Mini"
env_key = "MINI_END_USER_KEY"
api_backend = "responses"
`;
  const file = path.join(directory, "config.toml");
  await fs.writeFile(file, config, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

export async function executeTask({ env = process.env, runtimeFactory = (executor, options) => new AgentRuntime(executor, options) }:
  { env?: NodeJS.ProcessEnv; runtimeFactory?: RuntimeFactory } = {}): Promise<void> {
  const directory = taskDirectory(env);
  let outcome: Outcome;
  try {
    const task = claim(JSON.parse(await fs.readFile(path.join(directory, "claim.json"), "utf8")), env.TASK_ID);
    await configureProvider(task.executor, env);
    const workingDirectory = path.join(directory, "workspace");
    await fs.mkdir(workingDirectory, { mode: 0o700 });
    const runtime = runtimeFactory(task.executor, { env: agentEnvironment(env) });
    const result = await runtime.run({ prompt: task.prompt, workingDirectory });
    outcome = { status: "completed", result: boundedTaskResult(result.finalResponse) };
  } catch (error) {
    outcome = { status: "failed", error: safeError(error).toJSON() };
  }
  await privateJson(path.join(directory, "result.json"), outcome);
  if (outcome.status === "failed") throw new TaskError(outcome.error.code);
}

export async function finishTask({ env = process.env, fetchImpl = fetch, delay = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }:
  Options & { delay?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const directory = taskDirectory(env);
  let outcome: unknown;
  try { outcome = JSON.parse(await fs.readFile(path.join(directory, "result.json"), "utf8")); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new TaskError("INTERNAL_ERROR");
    outcome = { status: "failed", error: new TaskError(env.TASK_AGENT_OUTCOME === "skipped"
      ? "PROVIDER_UNAVAILABLE" : "PROVIDER_EXECUTION_ERROR").toJSON() };
  }
  // Retrying finish is safe only because its exact payload is idempotent.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await callback("finish", outcome, { env, fetchImpl, signal: AbortSignal.timeout(10_000) });
    } catch { /* An unknown delivery may be retried with a fresh assertion. */ }
    if (response?.ok) return;
    if (response && response.status < 500 && ![408, 429].includes(response.status)) {
      throw new TaskError("CLAIM_REJECTED");
    }
    if (attempt < 2) await delay(1000);
  }
  throw new TaskError("INTERNAL_ERROR");
}

function safeError(error: unknown): TaskError { return error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR"); }

async function main() {
  switch (process.env.INPUT_PHASE) {
    case "claim": return claimTask();
    case "execute": return executeTask();
    case "finish": return finishTask();
    default: throw new TaskError("INVALID_TASK_INPUT");
  }
}

if (import.meta.main) main().catch((error: unknown) => {
  const safe = safeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
});
