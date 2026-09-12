import { TASK_WORKFLOW } from "../../../shared/task-contract.js";
import { TaskError } from "../../../shared/task-errors.js";
import { githubHeaders } from "./github.js";

function repositoryPath(repository) {
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new TaskError("INTERNAL_ERROR");
  return `/repos/${repository}`;
}

export async function dispatchTaskWorkflow(env, token, taskId, fetchImpl = fetch) {
  const endpoint = `${repositoryPath(env.GITHUB_RUNNER_REPOSITORY)}/actions/workflows/${TASK_WORKFLOW}/dispatches`;
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${endpoint}`, {
      method: "POST", headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: env.GITHUB_RUNNER_REF ?? "main", inputs: { task_id: taskId } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { return "unknown"; }
  if (response.ok) return "accepted";
  return response.status >= 500 || response.status === 408 ? "unknown" : "rejected";
}

export async function observeTaskExecution(token, execution, fetchImpl = fetch, timeoutMs = 5000) {
  const endpoint = `${repositoryPath(execution.repository)}/actions/runs/${execution.runId}/attempts/${execution.runAttempt}`;
  const response = await githubTaskFetch(endpoint, token, {}, fetchImpl, timeoutMs);
  const run = await response.json().catch(() => undefined);
  if (String(run?.id) !== execution.runId || String(run?.run_attempt) !== execution.runAttempt ||
      run?.repository?.full_name !== execution.repository ||
      run?.path !== `.github/workflows/${TASK_WORKFLOW}` || String(run?.actor?.id) !== execution.ownerId ||
      !["queued", "in_progress", "waiting", "pending", "requested", "completed"].includes(run?.status)) {
    throw new TaskError("GITHUB_UNAVAILABLE");
  }
  if (run.status === "completed" &&
      !["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"].includes(run.conclusion)) {
    throw new TaskError("GITHUB_UNAVAILABLE");
  }
  return { status: run.status, conclusion: run.conclusion };
}

export async function cancelTaskWorkflow(token, execution, fetchImpl = fetch) {
  const endpoint = `${repositoryPath(execution.repository)}/actions/runs/${execution.runId}/cancel`;
  await githubTaskFetch(endpoint, token, { method: "POST" }, fetchImpl);
}

async function githubTaskFetch(endpoint, token, options, fetchImpl, timeoutMs = 5000) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${endpoint}`, {
      ...options, headers: githubHeaders(token), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    });
  } catch { throw new TaskError("GITHUB_UNAVAILABLE"); }
  if (response.status === 401) throw new TaskError("TASK_AUTH_REQUIRED");
  if (!response.ok) throw new TaskError("GITHUB_UNAVAILABLE");
  return response;
}
