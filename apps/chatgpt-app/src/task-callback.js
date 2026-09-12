import { TASK_LIMITS, TASK_WORKFLOW, isTaskId } from "../../../shared/task-contract.js";
import { TaskError } from "../../../shared/task-errors.js";
import { taskExecutionClaims, verifyRunnerIdentity } from "./runner-identity.js";
import { taskErrorResponse, taskRequest } from "./task-request.js";

export async function internalTaskFetch(request, env, keys) {
  const url = new URL(request.url);
  const route = /^\/internal\/tasks\/([^/]+)\/(claim|finish)$/.exec(url.pathname);
  if (request.method !== "POST" || !route || !isTaskId(route[1]) || url.search) {
    return taskErrorResponse(new TaskError("TASK_NOT_FOUND"));
  }
  const [, taskId, operation] = route;
  let execution;
  try {
    const claims = await verifyRunnerIdentity(request, env, TASK_WORKFLOW, undefined, keys);
    execution = taskExecutionClaims(claims, env);
  } catch {
    return taskErrorResponse(new TaskError("CLAIM_REJECTED"), 401);
  }
  try {
    if (operation === "claim") {
      // No caller-supplied owner or execution data enters the claim.
      const task = await taskRequest(env, taskId, "/claim", execution);
      return Response.json(task, { headers: { "cache-control": "no-store" } });
    }
    const finish = await readFinish(request);
    const task = await taskRequest(env, taskId, "/finish", { execution, finish });
    return Response.json({ status: task.status }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

async function readFinish(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) {
    throw new TaskError("INVALID_TASK_INPUT");
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TASK_LIMITS.callbackBytes) {
        await reader.cancel();
        throw new TaskError("INVALID_TASK_INPUT");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TaskError("INVALID_TASK_INPUT");
  } finally {
    reader.releaseLock();
  }
}
