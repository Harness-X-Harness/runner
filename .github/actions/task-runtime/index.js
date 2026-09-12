const fs = require("node:fs/promises");
const path = require("node:path");
const { AgentRuntime } = require("../agent-runtime");
const { TASK_LIMITS, isTaskId, boundedTaskResult } = require("../../../shared/task-contract.js");
const { TaskError } = require("../../../shared/task-errors.js");

function taskDirectory(env) {
  if (!isTaskId(env.TASK_ID) || !path.isAbsolute(env.RUNNER_TEMP ?? "")) throw new TaskError("INVALID_TASK_INPUT");
  return path.join(env.RUNNER_TEMP, `harness-${env.TASK_ID}`);
}

function controlPlaneOrigin(env) {
  const url = new URL(env.TASK_CONTROL_PLANE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new TaskError("INVALID_TASK_INPUT");
  }
  return url.origin;
}

async function privateJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function callback(phase, payload, { env, fetchImpl, signal }) {
  const origin = controlPlaneOrigin(env);
  const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  identityUrl.searchParams.set("audience", origin);
  const identity = await fetchImpl(identityUrl, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal,
  });
  if (!identity.ok) throw new TaskError("INTERNAL_ERROR");
  const token = (await identity.json()).value;
  if (typeof token !== "string" || !token) throw new TaskError("INTERNAL_ERROR");
  return fetchImpl(`${origin}/internal/tasks/${env.TASK_ID}/${phase}`, {
    method: "POST", signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function claimTask({ env = process.env, fetchImpl = fetch } = {}) {
  const directory = taskDirectory(env);
  const response = await callback("claim", {}, { env, fetchImpl });
  if (!response.ok) throw new TaskError("CLAIM_REJECTED");
  const task = await response.json();
  if (task.taskId !== env.TASK_ID || !["codex", "grok"].includes(task.executor) ||
      typeof task.prompt !== "string" || !task.prompt.trim() ||
      Buffer.byteLength(task.prompt) > TASK_LIMITS.promptBytes) throw new TaskError("CLAIM_REJECTED");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await privateJson(path.join(directory, "claim.json"), {
    taskId: task.taskId, executor: task.executor, prompt: task.prompt,
  });
  await fs.appendFile(env.GITHUB_OUTPUT, `executor=${task.executor}\n`);
}

function agentEnvironment(env) {
  const child = { ...env };
  delete child.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete child.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete child.GITHUB_TOKEN;
  return child;
}

async function configureProvider(executor, env) {
  const codex = executor === "codex";
  const endpoint = env[codex ? "MINI_CODEX_BASE_URL" : "MINI_GROK_BASE_URL"];
  if (!env.MINI_END_USER_KEY || !env.GH_TOKEN || !endpoint || !path.isAbsolute(env.HOME ?? "")) {
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

async function executeTask({ env = process.env, runtimeFactory = (executor, options) => new AgentRuntime(executor, options) } = {}) {
  const directory = taskDirectory(env);
  let outcome;
  try {
    const task = JSON.parse(await fs.readFile(path.join(directory, "claim.json"), "utf8"));
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

async function finishTask({ env = process.env, fetchImpl = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const directory = taskDirectory(env);
  let outcome;
  try { outcome = JSON.parse(await fs.readFile(path.join(directory, "result.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new TaskError("INTERNAL_ERROR");
    outcome = { status: "failed", error: new TaskError(env.TASK_AGENT_OUTCOME === "skipped"
      ? "PROVIDER_UNAVAILABLE" : "PROVIDER_EXECUTION_ERROR").toJSON() };
  }
  // Retrying finish is safe only because its exact payload is idempotent.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
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

function safeError(error) { return error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR"); }

async function main() {
  switch (process.env.INPUT_PHASE) {
    case "claim": return claimTask();
    case "execute": return executeTask();
    case "finish": return finishTask();
    default: throw new TaskError("INVALID_TASK_INPUT");
  }
}

if (require.main === module) main().catch((error) => {
  const safe = safeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
});

module.exports = { claimTask, executeTask, finishTask, agentEnvironment, taskDirectory };
