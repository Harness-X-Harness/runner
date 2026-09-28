import { TASK_WORKFLOW } from "../../../shared/task-contract.ts";
import { TaskError } from "../../../shared/task-errors.ts";
import { githubHeaders } from "./github.ts";
import { z } from "zod";
import type { TaskExecution } from "./task-request.ts";
import { ENVIRONMENT_WORKFLOW } from "./environment-callback.ts";

export type TaskGitHubEnvironment = { GITHUB_RUNNER_REPOSITORY: string; GITHUB_RUNNER_REF?: string };
const runSchema = z.object({
  id: z.union([z.string(), z.number()]), run_attempt: z.union([z.string(), z.number()]),
  repository: z.object({ full_name: z.string() }), path: z.string(), actor: z.object({ id: z.union([z.string(), z.number()]) }),
  status: z.enum(["queued", "in_progress", "waiting", "pending", "requested", "completed"]),
  conclusion: z.unknown().optional(),
});
const conclusionSchema = z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"]);
type Observation = { status: "completed"; conclusion: z.infer<typeof conclusionSchema> } |
  { status: Exclude<z.infer<typeof runSchema>["status"], "completed"> };

function repositoryPath(repository: string): string {
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new TaskError("INTERNAL_ERROR");
  return `/repos/${repository}`;
}

type DispatchResult = { status: "accepted"; response: Response } | { status: "unknown" | "rejected" };
export async function dispatchEnvironmentWorkflow(env: TaskGitHubEnvironment, token: string, environmentId: string,
  fetchImpl = fetch): Promise<{ status: "accepted"; runId: string } | { status: "unknown" | "rejected" }> {
  if (!/^env_[a-f0-9]{32}$/.test(environmentId)) throw new TaskError("INVALID_TASK_INPUT");
  const result = await dispatchWorkflow(env, token, ENVIRONMENT_WORKFLOW, { environment_id: environmentId }, fetchImpl);
  if (result.status !== "accepted") return result;
  const parsed = z.object({ workflow_run_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
    .safeParse(await result.response.json().catch(() => undefined));
  return parsed.success ? { status: "accepted", runId: String(parsed.data.workflow_run_id) } : { status: "unknown" };
}

async function dispatchWorkflow(env: TaskGitHubEnvironment, token: string, workflow: string,
  inputs: Record<string, string>, fetchImpl: typeof fetch): Promise<DispatchResult> {
  const endpoint = `${repositoryPath(env.GITHUB_RUNNER_REPOSITORY)}/actions/workflows/${workflow}/dispatches`;
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${endpoint}`, {
      method: "POST", headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: env.GITHUB_RUNNER_REF ?? "main", inputs }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { return { status: "unknown" }; }
  if (response.ok) return { status: "accepted", response };
  return { status: response.status >= 500 || response.status === 408 ? "unknown" : "rejected" };
}

export async function observeWorkflowExecution(token: string, execution: TaskExecution, workflow: string, fetchImpl = fetch, timeoutMs = 5000): Promise<Observation> {
  const endpoint = `${repositoryPath(execution.repository)}/actions/runs/${execution.runId}/attempts/${execution.runAttempt}`;
  const response = await githubTaskFetch(endpoint, token, {}, fetchImpl, timeoutMs);
  return readExecutionObservation(response, execution, workflow);
}

async function readExecutionObservation(response: Response, execution: TaskExecution, workflow: string): Promise<Observation> {
  return executionObservation(await response.json().catch(() => undefined), execution, workflow);
}

/** Shared exact-run validation for authenticated GitHub REST and signed events. */
export function executionObservation(value: unknown, execution: TaskExecution, workflow: string): Observation {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) throw new TaskError("GITHUB_UNAVAILABLE");
  const run = parsed.data;
  if (String(run.id) !== execution.runId || String(run.run_attempt) !== execution.runAttempt ||
      run.repository.full_name !== execution.repository ||
      run.path !== `.github/workflows/${workflow}` || String(run.actor.id) !== execution.ownerId) {
    throw new TaskError("GITHUB_UNAVAILABLE");
  }
  if (run.status === "completed") {
    const conclusion = conclusionSchema.safeParse(run.conclusion);
    if (!conclusion.success) throw new TaskError("GITHUB_UNAVAILABLE");
    return { status: "completed", conclusion: conclusion.data };
  }
  return { status: run.status };
}

/** GitHub cancel is run-scoped; validate its current attempt before requesting it. */
export async function requestWorkflowStop(token: string, execution: TaskExecution, workflow: string,
  fetchImpl = fetch): Promise<"completed" | "requested"> {
  const endpoint = `${repositoryPath(execution.repository)}/actions/runs/${execution.runId}`;
  const current = await readExecutionObservation(await githubTaskFetch(endpoint, token, {}, fetchImpl), execution, workflow);
  if (current.status === "completed") return "completed";
  await cancelTaskWorkflow(token, execution, fetchImpl);
  return "requested";
}

export async function cancelTaskWorkflow(token: string, execution: TaskExecution, fetchImpl = fetch): Promise<void> {
  const endpoint = `${repositoryPath(execution.repository)}/actions/runs/${execution.runId}/cancel`;
  await githubTaskFetch(endpoint, token, { method: "POST" }, fetchImpl);
}

/** Internal observer: execution must already be bound from verified workflow OIDC. */
export async function observeJobStart(token: string, execution: TaskExecution, jobName: string, fetchImpl = fetch): Promise<number> {
  const endpoint = `${repositoryPath(execution.repository)}/actions/runs/${execution.runId}/attempts/${execution.runAttempt}/jobs?per_page=100`;
  const response = await githubTaskFetch(endpoint, token, {}, fetchImpl);
  const parsed = z.object({
    total_count: z.number().int().nonnegative(),
    jobs: z.array(z.object({
      run_id: z.union([z.string(), z.number()]), name: z.string(),
      started_at: z.string().nullable(),
    })),
  }).safeParse(await response.json().catch(() => undefined));
  if (!parsed.success || parsed.data.total_count !== parsed.data.jobs.length) {
    throw new TaskError("GITHUB_UNAVAILABLE");
  }
  const matches = parsed.data.jobs.filter(job => job.name === jobName);
  if (matches.length !== 1 || String(matches[0]!.run_id) !== execution.runId) {
    throw new TaskError("GITHUB_UNAVAILABLE");
  }
  const startedAt = matches[0]!.started_at;
  const timestamp = startedAt === null ? NaN : Date.parse(startedAt);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new TaskError("GITHUB_UNAVAILABLE");
  return timestamp;
}

async function githubTaskFetch(endpoint: string, token: string, options: RequestInit, fetchImpl: typeof fetch, timeoutMs = 5000): Promise<Response> {
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
