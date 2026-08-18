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

export function webSocketRunnerToken(request, protocol = "harness.environment.v1") {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim());
  if (offered.length !== 2 || offered[0] !== protocol || !offered[1].startsWith("oidc.")) {
    throw new Error("runner WebSocket identity required");
  }
  const token = offered[1].slice("oidc.".length);
  if (!token) throw new Error("runner WebSocket identity required");
  return token;
}
