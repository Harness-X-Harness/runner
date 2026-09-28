import { authorizedSnapshots } from "./authorized-snapshots.ts";
import { DetailedTaskV2Schema, type DetailedTaskV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import { z } from "zod";
import { executionPrincipal } from "./execution-authority.ts";
import { ENVIRONMENT_SCOPE } from "./environment-service.ts";
import type { EnvironmentObject } from "./environment-object.ts";
import { lifecycleIdentity } from "./environment-lifecycle-task.ts";

type Store = { ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject, "observeOperation" | "observeLifecycleTask"> } };
const identity = z.string().regex(/^task_[a-f0-9]{32}_([a-f0-9]{32}|open|close)$/);

/** authorize must load current authority, not return a cached OAuth grant. */
export async function observeEnvironmentTask(env: Store, authorize: () => Promise<unknown>,
  value: unknown, signal: AbortSignal): Promise<AsyncGenerator<DetailedTaskV2>> {
  signal.throwIfAborted();
  const owner = executionPrincipal(await authorize(), ENVIRONMENT_SCOPE);
  const taskId = identity.parse(value);
  const lifecycle = lifecycleIdentity(taskId);
  const object = env.ENVIRONMENTS.getByName(`env_${taskId.slice(5, 37)}`);
  const stream = lifecycle ? await object.observeLifecycleTask(owner, lifecycle.kind)
    : await object.observeOperation(owner, taskId);
  return authorizedSnapshots(stream, signal, async () => {
    if (executionPrincipal(await authorize(), ENVIRONMENT_SCOPE) !== owner) throw new Error("TASK_AUTH_REQUIRED");
  }, value => {
    const task = DetailedTaskV2Schema.parse(value);
    if (task.taskId !== taskId) throw new Error("TASK_ID_MISMATCH");
    return task;
  });
}
