export function trustedRunnerClaims(payload, env, workflowId) {
  const configuredRef = env.GITHUB_RUNNER_REF ?? "main";
  const workflowRef = configuredRef.startsWith("refs/")
    ? configuredRef
    : `refs/heads/${configuredRef}`;
  const expectedWorkflow = `${env.GITHUB_RUNNER_REPOSITORY}/.github/workflows/${workflowId}@${workflowRef}`;
  if (
    payload.repository !== env.GITHUB_RUNNER_REPOSITORY ||
    payload.workflow_ref !== expectedWorkflow ||
    !payload.run_id
  ) throw new Error("runner identity is not trusted");
  return payload;
}
