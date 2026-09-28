import { taskExecutionClaims, verifyRunnerIdentity } from "./runner-identity.ts";
import type { EnvironmentObject } from "./environment-object.ts";

export const ENVIRONMENT_WORKFLOW = "run-environment.yml";
type Environment = Parameters<typeof verifyRunnerIdentity>[1] & {
  ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject, "claimRuntime" | "fetch"> };
};

// Not routed by the deployed Worker until the new workflow and lifecycle are ready.
export async function internalEnvironmentFetch(request: Request, env: Environment,
  keys?: Parameters<typeof verifyRunnerIdentity>[3]): Promise<Response> {
  const url = new URL(request.url);
  const route = /^\/internal\/environments\/(env_[a-f0-9]{32})\/(claim|connect)$/.exec(url.pathname);
  const reply = (status: number, body: unknown) => Response.json(body, {
    status, headers: { "cache-control": "no-store" },
  });
  if (!route || url.search || request.method !== (route[2] === "claim" ? "POST" : "GET")) return reply(404, { error: "NOT_FOUND" });
  let execution: ReturnType<typeof taskExecutionClaims>;
  try {
    const claims = await verifyRunnerIdentity(request, env, ENVIRONMENT_WORKFLOW, keys);
    execution = taskExecutionClaims(claims, env);
  } catch { return reply(401, { error: "RUNNER_IDENTITY_REJECTED" }); }
  try {
    if (route[2] === "connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return reply(400, { error: "WEBSOCKET_REQUIRED" });
      return await env.ENVIRONMENTS.getByName(route[1]).fetch(new Request("https://internal/connect", {
        headers: { upgrade: "websocket", "x-harness-runtime-claim": JSON.stringify({
          ...execution, runtimeId: request.headers.get("x-harness-runtime-id"),
        }) },
      }));
    }
    // Authority comes only from signed claims, never the request body.
    const token = request.headers.get("x-harness-github-token");
    if (!token) return reply(401, { error: "GITHUB_OBSERVATION_CREDENTIAL_REQUIRED" });
    const configuration = await env.ENVIRONMENTS.getByName(route[1]).claimRuntime(execution, token);
    return reply(200, configuration);
  } catch {
    // Do not expose storage failures, internal identities or credentials.
    return reply(503, { error: "ENVIRONMENT_CLAIM_UNAVAILABLE" });
  }
}
