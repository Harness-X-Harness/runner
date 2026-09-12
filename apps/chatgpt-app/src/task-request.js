import { isTaskId } from "../../../shared/task-contract.js";
import { TaskError } from "../../../shared/task-errors.js";

export async function taskRequest(env, taskId, operation, input) {
  if (!isTaskId(taskId)) throw new TaskError("TASK_NOT_FOUND");
  const stub = env.TASKS.get(env.TASKS.idFromName(taskId));
  const response = await stub.fetch(`https://task${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) {
    let error;
    try { error = new TaskError(result?.error?.code); }
    catch { error = new TaskError("INTERNAL_ERROR"); }
    throw error;
  }
  return result;
}

export function taskErrorResponse(error, status) {
  const safe = error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR");
  status ??= safe.code === "TASK_NOT_FOUND" ? 404 : safe.code === "CLAIM_REJECTED" ? 409 :
    safe.code === "INVALID_TASK_INPUT" ? 400 : 500;
  return Response.json({ error: safe.toJSON() }, { status, headers: { "cache-control": "no-store" } });
}
