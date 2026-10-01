import { runnerIdentity } from "../runner-identity.ts";
import { connectEnvironment, type RuntimeConnection } from "./environment-connection.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { serveEnvironmentConnections, type RuntimeReconnectDiagnostic } from "./environment-channel.ts";
import type { EnvironmentPort } from "./environment.ts";

const claimSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("stop") }).strict(),
  z.object({ decision: z.literal("bound"), executor: z.enum(["codex", "grok"]),
    deadline: z.number().int().positive() }).strict(),
]);

function environmentUrl(origin: string, environmentId: string, phase: "claim" | "connect"): URL {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.origin !== origin || !/^env_[a-f0-9]{32}$/.test(environmentId)) {
    throw new Error("INVALID_ENVIRONMENT_CONNECTION");
  }
  return new URL(`/internal/environments/${environmentId}/${phase}`, origin);
}

export async function claimRunnerEnvironment(origin: string, environmentId: string, signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<z.infer<typeof claimSchema>> {
  const url = environmentUrl(origin, environmentId, "claim");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_OBSERVATION_CREDENTIAL_REQUIRED");
  const token = await runnerIdentity(origin, env, fetchImpl, signal);
  try {
    const response = await fetchImpl(url, { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "x-harness-github-token": env.GITHUB_TOKEN } });
    if (!response.ok) throw new Error();
    const claim = claimSchema.parse(await response.json());
    if (claim.decision === "bound" && claim.deadline <= Date.now()) return { decision: "stop" };
    return claim;
  } catch { throw new Error("ENVIRONMENT_CLAIM_UNAVAILABLE"); }
}

/** One attempt against the fixed control plane; no tunnel or persistent token. */
export async function connectRunnerEnvironment(origin: string, environmentId: string, runtimeId: string,
  signal: AbortSignal, env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch): Promise<RuntimeConnection> {
  const url = environmentUrl(origin, environmentId, "connect");
  url.protocol = "wss:";
  return connectEnvironment(url, runtimeId, () => runnerIdentity(origin, env, fetchImpl, signal), signal);
}

export async function serveRunnerEnvironment(environment: EnvironmentPort, origin: string, environmentId: string,
  deadline: number, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch,
  diagnostic?: (fact: RuntimeReconnectDiagnostic) => void): Promise<void> {
  environmentUrl(origin, environmentId, "connect");
  const runtimeId = randomUUID();
  return serveEnvironmentConnections(environment, deadline,
    signal => connectRunnerEnvironment(origin, environmentId, runtimeId, signal, env, fetchImpl), diagnostic);
}
