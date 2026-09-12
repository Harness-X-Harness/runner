import { isTerminalTask, newTaskId } from "../../../shared/task-contract.js";
import { TaskError } from "../../../shared/task-errors.js";
import { taskRequest } from "./task-request.js";
import { taskWaitSeconds, validateTaskInput } from "./task-state.js";
import { cancelTaskWorkflow, dispatchTaskWorkflow, observeTaskExecution } from "./task-github.js";

function principal(props) {
  if (!props?.oauthScopes?.includes("tasks:manage") || !/^[1-9]\d*$/.test(String(props?.githubUserId ?? ""))) {
    throw new TaskError("TASK_AUTH_REQUIRED");
  }
  return String(props.githubUserId);
}

function executionToken(props) {
  if (props.githubAuthorizationKind !== "github_app_scoped" ||
      typeof props.environmentGithubAccessToken !== "string" || !props.environmentGithubAccessToken ||
      (props.environmentGithubAccessTokenExpiresAt !== undefined &&
       props.environmentGithubAccessTokenExpiresAt <= Date.now() / 1000)) {
    throw new TaskError("TASK_AUTH_REQUIRED");
  }
  return props.environmentGithubAccessToken;
}

export async function runTask(env, props, input, fetchImpl = fetch) {
  const ownerId = principal(props);
  const token = executionToken(props);
  validateTaskInput(input);
  const taskId = newTaskId();
  await taskRequest(env, taskId, "/create", { taskId, ownerId,
    executor: input.executor, prompt: input.prompt, repository: env.GITHUB_RUNNER_REPOSITORY });
  const outcome = await dispatchTaskWorkflow(env, token, taskId, fetchImpl);
  if (outcome === "rejected") return taskRequest(env, taskId, "/dispatch-failed", { ownerId });
  // Neither an unknown response nor a lost claim response permits another dispatch.
  return taskRequest(env, taskId, "/read", { ownerId });
}

async function reconcileTask(env, props, taskId, control, fetchImpl, timeoutMs = 5000) {
  if (isTerminalTask(control.task.status) || !control.execution) return control.task;
  const observed = await observeTaskExecution(executionToken(props), control.execution, fetchImpl, timeoutMs);
  if (observed.status === "completed") return taskRequest(env, taskId, "/execution-ended", {
    ownerId: principal(props), execution: control.execution, conclusion: observed.conclusion,
  });
  return taskRequest(env, taskId, "/read", { ownerId: principal(props) });
}

export async function waitTask(env, props, { taskId, timeoutSeconds }, fetchImpl = fetch) {
  const ownerId = principal(props);
  const seconds = taskWaitSeconds(timeoutSeconds);
  const deadline = Date.now() + seconds * 1000;
  const control = await taskRequest(env, taskId, "/control", { ownerId });
  if (isTerminalTask(control.task.status) || seconds === 0) return control.task;
  const task = await reconcileTask(env, props, taskId, control, fetchImpl,
    Math.min(5000, Math.max(1, deadline - Date.now())));
  if (isTerminalTask(task.status) || task.updatedAt !== control.task.updatedAt || task.status !== control.task.status) return task;
  return taskRequest(env, taskId, "/wait", { ownerId, observedStatus: task.status,
    timeoutSeconds: Math.max(0, (deadline - Date.now()) / 1000) });
}

export async function cancelTask(env, props, { taskId }, fetchImpl = fetch) {
  const ownerId = principal(props);
  const control = await taskRequest(env, taskId, "/cancel", { ownerId });
  const task = await reconcileTask(env, props, taskId, control, fetchImpl);
  if (isTerminalTask(task.status) || !control.execution) return task;
  await cancelTaskWorkflow(executionToken(props), control.execution, fetchImpl);
  // A successful cancel request is not a terminal GitHub observation.
  return taskRequest(env, taskId, "/read", { ownerId });
}
