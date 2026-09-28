import { z } from "zod";
import type { EnvironmentAdmissionObject, EnvironmentObject } from "./environment-object.ts";
import { executionPrincipal } from "./execution-authority.ts";
import { ENVIRONMENT_SCOPE } from "./environment-service.ts";
import { authorizedSnapshots } from "./authorized-snapshots.ts";
import { TaskError } from "../../../shared/task-errors.ts";

export type EnvironmentResources = {
  ENVIRONMENT_ADMISSION: { getByName(name: string): Pick<EnvironmentAdmissionObject, "list"> };
  ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject, "readEnvironment" | "readOutput"> };
};
const uriSchema = z.string().regex(/^harness:\/\/environments\/env_[a-f0-9]{32}$/);
const outputUriSchema = z.string().regex(/^harness:\/\/tasks\/task_[a-f0-9]{32}_[a-f0-9]{32}\/output$/);
export const environmentUri = (environmentId: string) => uriSchema.parse(`harness://environments/${environmentId}`);
export const outputUri = (taskId: string) => outputUriSchema.parse(`harness://tasks/${taskId}/output`);

export async function observeEnvironmentResource(env: { ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject, "observeOutput" | "observeEnvironment"> } },
  authorize: () => Promise<unknown>, uri: string, signal: AbortSignal): Promise<AsyncIterable<void>> {
  signal.throwIfAborted();
  const owner = executionPrincipal(await authorize(), ENVIRONMENT_SCOPE);
  const { environmentId, taskId } = resourceIdentity(uri);
  const object = env.ENVIRONMENTS.getByName(environmentId);
  const stream = taskId ? await object.observeOutput(owner, taskId) : await object.observeEnvironment(owner);
  return authorizedSnapshots(stream, signal, async () => {
    if (executionPrincipal(await authorize(), ENVIRONMENT_SCOPE) !== owner) throw new Error("TASK_AUTH_REQUIRED");
  }, () => undefined);
}

function resourceIdentity(uri: unknown) {
  const parsed = z.union([uriSchema, outputUriSchema]).parse(uri);
  const taskId = outputUriSchema.safeParse(parsed).success ? parsed.slice("harness://tasks/".length, -"/output".length) : undefined;
  const environmentId = taskId ? `env_${taskId.slice(5, 37)}` : parsed.slice("harness://environments/".length);
  return { uri: parsed, environmentId, taskId };
}

export async function listEnvironmentResources(env: EnvironmentResources, props: unknown) {
  const ownerId = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const ids = await env.ENVIRONMENT_ADMISSION.getByName("global").list(ownerId);
  // Membership and lifecycle are separate authorities, not one cross-object snapshot.
  // Never turn a failed lifecycle read into an empty or allegedly complete catalog.
  const snapshots = await Promise.all(ids.sort().map(id => env.ENVIRONMENTS.getByName(id).readEnvironment(ownerId)));
  const available = snapshots.map(value => {
    if (value === null) throw new TaskError("RESOURCE_NOT_FOUND");
    return value;
  });
  return { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const, resources: available.filter(value => value.status !== "closed").map(value => ({
    uri: environmentUri(value.environmentId), name: value.environmentId,
    title: `${value.executor} Environment`, mimeType: "application/json",
  })) };
}

export async function readEnvironmentResource(env: EnvironmentResources, props: unknown, uri: unknown) {
  const ownerId = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const { uri: parsed, environmentId, taskId } = resourceIdentity(uri);
  const object = env.ENVIRONMENTS.getByName(environmentId);
  const snapshot = taskId ? await object.readOutput(ownerId, taskId) : await object.readEnvironment(ownerId);
  if (snapshot === null) throw new TaskError("RESOURCE_NOT_FOUND");
  return { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const, contents: [
    { uri: parsed, mimeType: "application/json", text: JSON.stringify(snapshot) },
  ] };
}
