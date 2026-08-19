const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export class EnvironmentDispatchError extends Error {
  /**
   * @param {string} message
   * @param {"rejected" | "unknown"} outcome
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, outcome, options) {
    super(message, options);
    this.outcome = outcome;
  }
}

export async function dispatchEnvironmentWorkflow(
  env,
  accessToken,
  environment,
  fetchImpl = fetch,
) {
  let owner;
  let repository;
  try {
    requireAccessToken(accessToken);
    [owner, repository] = runnerRepository(env);
  } catch (error) {
    throw new EnvironmentDispatchError(
      error instanceof Error ? error.message : "GitHub Environment dispatch was not issued",
      "rejected",
      { cause: error },
    );
  }
  const workflow = env.GITHUB_ENVIRONMENT_WORKFLOW_ID ?? "private-runner-session.yml";
  let response;
  try {
    response = await githubFetch(
      `/repos/${owner}/${repository}/actions/workflows/${workflow}/dispatches`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          ref: env.GITHUB_RUNNER_REF ?? "main",
          inputs: {
            environment_id: environment.environmentId,
            environment_owner: environment.environmentOwner,
          },
        }),
      },
      fetchImpl,
    );
  } catch (error) {
    throw new EnvironmentDispatchError(
      "GitHub Environment workflow dispatch outcome is unknown",
      "unknown",
      { cause: error },
    );
  }
  const run = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !run?.workflow_run_id ||
    typeof run?.html_url !== "string"
  ) {
    const outcome = response.ok || response.status >= 500 || response.status === 408
      ? "unknown"
      : "rejected";
    throw new EnvironmentDispatchError(
      `GitHub Environment workflow dispatch failed with ${response.status}`,
      outcome,
    );
  }
  return {
    runId: String(run.workflow_run_id),
    runUrl: run.html_url,
  };
}

export async function cancelEnvironmentWorkflow(
  env,
  accessToken,
  runId,
  fetchImpl = fetch,
) {
  requireAccessToken(accessToken);
  const [owner, repository] = runnerRepository(env);
  const response = await githubFetch(
    `/repos/${owner}/${repository}/actions/runs/${encodeURIComponent(runId)}/cancel`,
    accessToken,
    { method: "POST" },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`GitHub Environment workflow cancellation failed with ${response.status}`);
  }
}

export async function getEnvironmentWorkflowRun(
  env,
  accessToken,
  runId,
  fetchImpl = fetch,
) {
  requireAccessToken(accessToken);
  const [owner, repository] = runnerRepository(env);
  const response = await githubFetch(
    `/repos/${owner}/${repository}/actions/runs/${encodeURIComponent(runId)}`,
    accessToken,
    {},
    fetchImpl,
  );
  const run = await response.json().catch(() => undefined);
  if (!response.ok || typeof run?.status !== "string") {
    throw new Error(`GitHub Environment workflow lookup failed with ${response.status}`);
  }
  return { status: run.status, conclusion: run.conclusion ?? undefined };
}

function runnerRepository(env) {
  const parts = env.GITHUB_RUNNER_REPOSITORY.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("GitHub runner repository is invalid");
  }
  return parts;
}

function requireAccessToken(accessToken) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("GitHub OAuth authorization is required");
  }
}

async function githubFetch(path, token, options = {}, fetchImpl = fetch) {
  return fetchImpl(`${API}${path}`, {
    ...options,
    headers: {
      ...githubHeaders(token),
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

export function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "HarnessXHarness",
    "x-github-api-version": API_VERSION,
  };
}
