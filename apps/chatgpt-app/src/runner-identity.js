import { createRemoteJWKSet, jwtVerify } from "jose";

const githubOidcKeys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);

export async function verifyRunnerIdentity(request, env, workflowId, keys = githubOidcKeys) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new Error("runner identity required");
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "nbf"],
    issuer: "https://token.actions.githubusercontent.com",
    audience: new URL(env.TASK_CONTROL_PLANE_URL).origin,
  });
  return trustedRunnerClaims(payload, env, workflowId);
}

export function trustedRunnerClaims(payload, env, workflowId) {
  const configuredRef = env.GITHUB_RUNNER_REF ?? "main";
  const workflowRef = configuredRef.startsWith("refs/")
    ? configuredRef
    : `refs/heads/${configuredRef}`;
  const expectedWorkflow = `${env.GITHUB_RUNNER_REPOSITORY}/.github/workflows/${workflowId}@${workflowRef}`;
  if (
    payload.repository !== env.GITHUB_RUNNER_REPOSITORY ||
    payload.workflow_ref !== expectedWorkflow ||
    !/^\d+$/.test(String(payload.run_id ?? "")) ||
    !/^\d+$/.test(String(payload.run_attempt ?? ""))
  ) throw new Error("runner identity is not trusted");
  return payload;
}

export function taskExecutionClaims(payload, env) {
  const configuredRef = env.GITHUB_RUNNER_REF ?? "main";
  const ref = configuredRef.startsWith("refs/") ? configuredRef : `refs/heads/${configuredRef}`;
  if (payload.ref !== ref || !ref.startsWith("refs/heads/") || payload.ref_protected !== "true" ||
      payload.event_name !== "workflow_dispatch" || payload.runner_environment !== "github-hosted" ||
      !/^[1-9]\d*$/.test(String(payload.actor_id ?? "")) ||
      !/^[1-9]\d*$/.test(String(payload.run_id ?? "")) ||
      !/^[1-9]\d*$/.test(String(payload.run_attempt ?? ""))) {
    throw new Error("task execution is not trusted");
  }
  return { ownerId: String(payload.actor_id), repository: String(payload.repository),
    runId: String(payload.run_id), runAttempt: String(payload.run_attempt) };
}
