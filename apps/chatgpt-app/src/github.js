const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export async function dispatchWorkflow(env, task) {
  const token = await installationToken(env);
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
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with ${response.status}`);
  }
}

export async function cancelWorkflow(env, task) {
  if (!task.runId) return;
  const token = await installationToken(env);
  const [owner, repository] = runnerRepository(env);
  const response = await githubFetch(
    `/repos/${owner}/${repository}/actions/runs/${encodeURIComponent(task.runId)}/cancel`,
    token,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`GitHub workflow cancellation failed with ${response.status}`);
  }
}

export async function authorizeRepository(repo, props, mode, ref) {
  const token = props?.githubAccessToken;
  if (!token) throw new Error("GitHub authorization is required");
  const response = await fetch(`${API}/repos/${repo}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) throw new Error("GitHub repository is not accessible");
  const repository = await response.json();
  if (mode !== "analyze" && !repository.permissions?.push) {
    throw new Error("GitHub write access is required for this task mode");
  }
  if (mode === "pull_request") {
    const branchResponse = await fetch(
      `${API}/repos/${repo}/branches/${encodeURIComponent(ref)}`,
      { headers: githubHeaders(token) },
    );
    if (!branchResponse.ok) {
      throw new Error("pull_request mode requires ref to name an accessible branch");
    }
  }
  return repository;
}

async function installationToken(env) {
  const appJwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const [owner, repository] = runnerRepository(env);
  const installationResponse = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`,
    appJwt,
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
  );
  if (!response.ok) throw new Error(`GitHub App token request failed with ${response.status}`);
  return (await response.json()).token;
}

function runnerRepository(env) {
  return env.GITHUB_RUNNER_REPOSITORY.split("/");
}

async function githubFetch(path, token, options = {}) {
  return fetch(`${API}${path}`, {
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
    "user-agent": "WeaverTaskRunner",
    "x-github-api-version": API_VERSION,
  };
}

async function signAppJwt(appId, privateKeyPem) {
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
