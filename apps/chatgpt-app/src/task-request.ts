import { isTaskId } from "../../../shared/task-contract.ts";
import { TaskError } from "../../../shared/task-errors.ts";
import { z } from "zod";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type TaskEnvironment = { TASKS: DurableObjectNamespace };
export const taskSnapshotSchema = z.object({
  taskId: z.string(), executor: z.enum(["codex", "grok"]),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  createdAt: z.string(), updatedAt: z.string(), finishedAt: z.string().optional(), runUrl: z.string().optional(),
  result: z.object({ finalResponse: z.string(), truncated: z.boolean().optional() }).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
});
const executionSchema = z.object({ ownerId: z.string(), repository: z.string(), runId: z.string(), runAttempt: z.string() });
const controlSchema = z.object({ task: taskSnapshotSchema, execution: executionSchema.optional() });
const claimSchema = z.object({ taskId: z.string(), executor: z.enum(["codex", "grok"]), prompt: z.string() });
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskControl = z.infer<typeof controlSchema>;
export type TaskExecution = z.infer<typeof executionSchema>;
type TaskClaim = z.infer<typeof claimSchema>;
type SnapshotOperation = "/create" | "/read" | "/wait" | "/finish" | "/dispatch-failed" | "/execution-ended";

export function taskRequest(env: TaskEnvironment, taskId: string, operation: "/control" | "/cancel", input: unknown): Promise<TaskControl>;
export function taskRequest(env: TaskEnvironment, taskId: string, operation: "/claim", input: unknown): Promise<TaskClaim>;
export function taskRequest(env: TaskEnvironment, taskId: string, operation: SnapshotOperation, input: unknown): Promise<TaskSnapshot>;
export async function taskRequest(
  env: TaskEnvironment, taskId: string, operation: SnapshotOperation | "/control" | "/cancel" | "/claim", input: unknown,
): Promise<TaskSnapshot | TaskControl | TaskClaim> {
  if (!isTaskId(taskId)) throw new TaskError("TASK_NOT_FOUND");
  const stub = env.TASKS.get(env.TASKS.idFromName(taskId));
  const response = await stub.fetch(`https://task${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    let error;
    try {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).parse(result);
      error = new TaskError(parsed.error.code);
    }
    catch { error = new TaskError("INTERNAL_ERROR"); }
    throw error;
  }
  const schema = operation === "/control" || operation === "/cancel" ? controlSchema :
    operation === "/claim" ? claimSchema : taskSnapshotSchema;
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new TaskError("INTERNAL_ERROR");
  return parsed.data;
}

export function taskErrorResponse(error: unknown, status?: number): Response {
  const safe = error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR");
  status ??= safe.code === "TASK_NOT_FOUND" ? 404 : safe.code === "CLAIM_REJECTED" ? 409 :
    safe.code === "INVALID_TASK_INPUT" ? 400 : 500;
  return Response.json({ error: safe.toJSON() }, { status, headers: { "cache-control": "no-store" } });
}
