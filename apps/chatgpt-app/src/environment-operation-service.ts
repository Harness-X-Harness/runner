import { z } from "zod";
import { executionPrincipal, executionToken } from "./execution-authority.ts";
import { lifecycleIdentity } from "./environment-lifecycle-task.ts";
import { ENVIRONMENT_SCOPE } from "./environment-service.ts";
import type { EnvironmentObject } from "./environment-object.ts";
import { environmentTask } from "./environment-task.ts";
import { TaskError } from "../../../shared/task-errors.ts";

type Store = { ENVIRONMENTS: { getByName(name: string):
  Pick<EnvironmentObject, "reserveOperation" | "readOperation"> } };
const environmentId = z.string().regex(/^env_[a-f0-9]{32}$/);
const common = { environmentId, idempotencyKey: z.string().min(1).max(256).optional() };
export const commandInput = z.object({ ...common,
    argv: z.tuple([z.string().min(1)]).rest(z.string()),
    cwd: z.string().default("."), timeoutSeconds: z.number().positive() }).strict();
const modelName = z.string().min(1).max(200).regex(/^[A-Za-z0-9._~-]+$/);
const effortName = z.string().min(1).max(32).regex(/^[A-Za-z0-9._~-]+$/);
export const agentInput = z.object({ ...common,
    prompt: z.string().min(1).regex(/\S/),
    model: modelName.optional(),
    reasoningEffort: effortName.optional(),
  }).strict();
const input = z.discriminatedUnion("kind", [
  commandInput.extend({ kind: z.literal("command") }),
  agentInput.extend({ kind: z.literal("agent") }),
]);
const taskIdSchema = z.string().regex(/^task_[a-f0-9]{32}_[a-f0-9]{32}$/);
function taskIdentity(value: unknown): string {
  const parsed = taskIdSchema.safeParse(value);
  if (!parsed.success) throw new TaskError("TASK_NOT_FOUND");
  return parsed.data;
}

/** Operation identity routes to its owner-checked Environment; no global Task index. */
export async function startEnvironmentOperation(env: Store, props: unknown, value: unknown) {
  const owner = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const parsed = input.parse(value);
  const { environmentId: id, idempotencyKey, ...operation } = parsed;
  const request = JSON.stringify(operation);
  if (new TextEncoder().encode(request).length > 65536) throw new Error("INVALID_OPERATION_INPUT");
  const bytes = idempotencyKey === undefined ? crypto.getRandomValues(new Uint8Array(16))
    : new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify([owner, id, idempotencyKey])))).slice(0, 16);
  const suffix = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const taskId = `task_${id.slice(4)}_${suffix}`;
  await env.ENVIRONMENTS.getByName(id).reserveOperation(owner, taskId, request);
  return { taskId };
}

/** Internal read authority. The MCP projection must not expose the private request. */
export async function readEnvironmentOperation(env: Store, props: unknown, value: unknown) {
  const owner = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const taskId = taskIdentity(value);
  const record = await env.ENVIRONMENTS.getByName(`env_${taskId.slice(5, 37)}`).readOperation(owner, taskId);
  if (!record) throw new TaskError("TASK_NOT_FOUND");
  return record;
}

export async function getEnvironmentTask(env: { ENVIRONMENTS: { getByName(name: string):
  Pick<EnvironmentObject, "readLifecycleTask" | "readOperation" | "reserveOperation"> } }, props: unknown, taskId: unknown) {
  const lifecycle = typeof taskId === "string" ? lifecycleIdentity(taskId) : undefined;
  if (lifecycle) {
    const owner = executionPrincipal(props, ENVIRONMENT_SCOPE);
    const task = await env.ENVIRONMENTS.getByName(lifecycle.environmentId).readLifecycleTask(owner, lifecycle.kind);
    if (!task) throw new TaskError("TASK_NOT_FOUND");
    return task;
  }
  const id = taskIdentity(taskId);
  return environmentTask(id, await readEnvironmentOperation(env, props, id));
}

export async function cancelEnvironmentTask(env: { ENVIRONMENTS: { getByName(name: string):
  Pick<EnvironmentObject, "cancelOperation" | "cancelLifecycleTask" | "readLifecycleTask" | "closeExecution"> } }, props: unknown, value: unknown) {
  const owner = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const lifecycle = typeof value === "string" ? lifecycleIdentity(value) : undefined;
  if (lifecycle) {
    const object = env.ENVIRONMENTS.getByName(lifecycle.environmentId);
    if (!await object.readLifecycleTask(owner, lifecycle.kind)) throw new TaskError("TASK_NOT_FOUND");
    if (await object.cancelLifecycleTask(owner, lifecycle.kind)) await object.closeExecution(owner, executionToken(props));
    return { resultType: "complete" as const };
  }
  const taskId = taskIdentity(value);
  await env.ENVIRONMENTS.getByName(`env_${taskId.slice(5, 37)}`).cancelOperation(owner, taskId);
  return { resultType: "complete" as const };
}

export async function updateEnvironmentTask(env: { ENVIRONMENTS: { getByName(name: string):
  Pick<EnvironmentObject, "answerOperation"> } }, props: unknown, value: unknown, responses: unknown) {
  const owner = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const taskId = taskIdentity(value);
  await env.ENVIRONMENTS.getByName(`env_${taskId.slice(5, 37)}`).answerOperation(owner, taskId, responses);
  return { resultType: "complete" as const };
}
