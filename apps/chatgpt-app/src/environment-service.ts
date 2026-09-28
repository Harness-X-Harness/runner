import { z } from "zod";
import { executionPrincipal, executionToken } from "./execution-authority.ts";
import type { EnvironmentObject } from "./environment-object.ts";

// A fresh product scope. Neither legacy environments:manage nor tasks:manage implies it.
export const ENVIRONMENT_SCOPE = "environments:use";
type EnvironmentService = { ENVIRONMENTS: { getByName(name: string):
  Pick<EnvironmentObject, "initialize" | "dispatchExecution" | "requestClose" | "closeExecution"> } };
export const openInput = z.object({ executor: z.enum(["codex", "grok"]),
  idempotencyKey: z.string().min(1).max(256).optional() }).strict();
export const environmentIdentity = z.object({ environmentId: z.string().regex(/^env_[a-f0-9]{32}$/) }).strict();

/** Internal service; public MCP capability checking must precede this effectful call. */
export async function openEnvironment(env: EnvironmentService, props: unknown, value: unknown) {
  const ownerId = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const token = executionToken(props);
  const input = openInput.parse(value);
  const bytes = input.idempotencyKey === undefined ? crypto.getRandomValues(new Uint8Array(16))
    : new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify(["environment-open", ownerId, input.idempotencyKey])))).slice(0, 16);
  const environmentId = `env_${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const object = env.ENVIRONMENTS.getByName(environmentId);
  const creation = await object.initialize({ environmentId, ownerId, executor: input.executor });
  const dispatch = await object.dispatchExecution(ownerId, token);
  return { environmentId, executor: creation.executor, createdAt: creation.createdAt, dispatch };
}

export async function closeEnvironment(env: EnvironmentService, props: unknown, value: unknown) {
  const ownerId = executionPrincipal(props, ENVIRONMENT_SCOPE);
  const { environmentId } = environmentIdentity.parse(value);
  const object = env.ENVIRONMENTS.getByName(environmentId);
  // Preserve stop intent even when the current external credential has expired.
  const status = await object.requestClose(ownerId);
  if (status === "closed") return { environmentId, status };
  return { environmentId, status: await object.closeExecution(ownerId, executionToken(props)) };
}
