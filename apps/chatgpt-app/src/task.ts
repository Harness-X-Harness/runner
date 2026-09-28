import { isTerminalTask, newTaskId, TASK_WORKFLOW } from "../../../shared/task-contract.ts";
import { taskRequest, type TaskEnvironment, type TaskControl, type TaskSnapshot } from "./task-request.ts";
import { taskWaitSeconds, validateTaskInput } from "./task-state.ts";
import { cancelTaskWorkflow, dispatchTaskWorkflow, observeWorkflowExecution, type TaskGitHubEnvironment } from "./task-github.ts";
import { executionPrincipal, executionToken } from "./execution-authority.ts";

export type TaskEnv = TaskEnvironment & TaskGitHubEnvironment;
export type RunTaskInput = { executor: "codex" | "grok"; prompt: string };

function principal(props: unknown): string {
  return executionPrincipal(props, "tasks:manage");
}

export async function runTask(env: TaskEnv, props: unknown, input: RunTaskInput, fetchImpl = fetch): Promise<TaskSnapshot> {
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

async function reconcileTask(env: TaskEnv, props: unknown, taskId: string, control: TaskControl, fetchImpl: typeof fetch, timeoutMs = 5000): Promise<TaskSnapshot> {
  if (isTerminalTask(control.task.status) || !control.execution) return control.task;
  const observed = await observeWorkflowExecution(executionToken(props), control.execution, TASK_WORKFLOW, fetchImpl, timeoutMs);
  if (observed.status === "completed") return taskRequest(env, taskId, "/execution-ended", {
    ownerId: principal(props), execution: control.execution, conclusion: observed.conclusion,
  });
  return taskRequest(env, taskId, "/read", { ownerId: principal(props) });
}

export async function waitTask(env: TaskEnv, props: unknown, { taskId, timeoutSeconds }: { taskId: string; timeoutSeconds?: number }, fetchImpl = fetch): Promise<TaskSnapshot> {
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

export async function cancelTask(env: TaskEnv, props: unknown, { taskId }: { taskId: string }, fetchImpl = fetch): Promise<TaskSnapshot> {
  const ownerId = principal(props);
  const control = await taskRequest(env, taskId, "/cancel", { ownerId });
  const task = await reconcileTask(env, props, taskId, control, fetchImpl);
  if (isTerminalTask(task.status) || !control.execution) return task;
  await cancelTaskWorkflow(executionToken(props), control.execution, fetchImpl);
  // A successful cancel request is not a terminal GitHub observation.
  return taskRequest(env, taskId, "/read", { ownerId });
}
