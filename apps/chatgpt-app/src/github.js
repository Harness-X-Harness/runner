const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const installationTokenCache = new Map();

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

export async function dispatchWorkflow(env, task, fetchImpl = fetch) {
  const token = await installationToken(env, fetchImpl);
  const [owner, repository] = runnerRepository(env);
  const workflow = env.GITHUB_WORKFLOW_ID ?? "execute-task.yml";
  const response = await githubFetch(
    `/repos/${owner}/${repository}/actions/workflows/${workflow}/dispatches`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        ref: env.GITHUB_RUNNER_REF ?? "main",
        inputs: {
          task_id: task.id,
          repo: task.repo,
          ref: task.ref,
          executor: task.executor,
          mode: task.mode,
          repository_access: task.repositoryAccess,
        },
      }),
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with ${response.status}`);
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

export async function cancelWorkflow(env, task, fetchImpl = fetch) {
  if (!task.runId) return;
  const token = await installationToken(env, fetchImpl);
  const [owner, repository] = runnerRepository(env);
  const response = await githubFetch(
    `/repos/${owner}/${repository}/actions/runs/${encodeURIComponent(task.runId)}/cancel`,
    token,
    { method: "POST" },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`GitHub workflow cancellation failed with ${response.status}`);
  }
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

async function installationToken(env, fetchImpl) {
  const cacheKey = `${env.GITHUB_APP_ID}:${env.GITHUB_RUNNER_REPOSITORY}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached?.expiresAt > Date.now() + 60_000) return cached.token;

  const appJwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [owner, repository] = runnerRepository(env);
  const installationResponse = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
    appJwt,
    {},
    fetchImpl,
  );
  if (!installationResponse.ok) {
    throw new Error(
      `GitHub App installation lookup failed with ${installationResponse.status}`,
    );
  }
  const installationId = (await installationResponse.json()).id;
  if (!installationId) throw new Error("GitHub App installation lookup returned no ID");

  const response = await githubFetch(
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    appJwt,
    {
      method: "POST",
      body: JSON.stringify({
        repositories: [repository],
        permissions: { actions: "write" },
      }),
    },
    fetchImpl,
  );
  if (!response.ok) throw new Error(`GitHub App token request failed with ${response.status}`);
  const installation = await response.json();
  const expiresAt = Date.parse(installation.expires_at ?? "");
  if (installation.token && Number.isFinite(expiresAt)) {
    installationTokenCache.set(cacheKey, {
      token: installation.token,
      expiresAt,
    });
  }
  return installation.token;
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
    "user-agent": "HarnessXHarnessTaskRunner",
    "x-github-api-version": API_VERSION,
  };
}

export async function signAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem) {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  const bytes = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  return isPkcs1 ? wrapPkcs1InPkcs8(bytes) : bytes.buffer;
}

function wrapPkcs1InPkcs8(pkcs1) {
  const algorithmIdentifier = Uint8Array.from([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ]);
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const privateKey = der(0x04, pkcs1);
  return der(0x30, concat(version, algorithmIdentifier, privateKey)).buffer;
}

function der(tag, value) {
  return concat(Uint8Array.from([tag]), derLength(value.length), value);
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.from([length]);

  const bytes = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encode(value) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
