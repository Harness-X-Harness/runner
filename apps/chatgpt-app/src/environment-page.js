import { readEnvironment, reconcileEnvironment } from "./environment.js";
import { getEnvironmentWorkflowRun } from "./github.js";
import { startGitHubAuthorization } from "./github-oauth-state.js";
import {
  exchangeGitHubUserCode,
  requestGitHubUserProfile,
  scopeGitHubUserToken,
} from "./github-user-auth.js";

const SESSION_COOKIE = "__Host-RUNNER_ENVIRONMENT";
const SESSION_TTL = 6 * 60 * 60;
const SESSION_VERSION = "v1";
const SESSION_CONTEXT = new TextEncoder().encode("harness-environment-session-v1");

export async function environmentEntry(
  request,
  env,
  observeRun = getEnvironmentWorkflowRun,
) {
  const url = new URL(request.url);
  const session = await readSession(
    cookieValue(request.headers.get("cookie"), SESSION_COOKIE),
    env.ENVIRONMENT_SESSION_SECRET,
  );
  if (!session) {
    return startGitHubAuthorization(
      env,
      `${url.origin}/github/callback`,
      { kind: "environment" },
      "environment_oauth_",
    );
  }

  let environment = await readEnvironment(env, session.githubUserId);
  if (environment?.runId) {
    environment = await reconcileEnvironment(
      env,
      session.githubUserId,
      environment,
      (workerEnv, runId) =>
        observeRun(workerEnv, session.githubAccessToken, runId),
    );
  }
  if (!environment || environment.status === "offline") {
    return page(
      "Private development environment is offline",
      "<p>Open an environment from ChatGPT to start a new session.</p>",
    );
  }
  if (environment.status === "ready" && environment.pairingUrl) {
    return noStoreRedirect(environment.pairingUrl);
  }

  const runLink = environment.runUrl
    ? `<p><a href="${escapeHtml(environment.runUrl)}">View the GitHub Actions run</a></p>`
    : "";
  const preparing = environment.dispatchOutcome
    ? "GitHub has not confirmed whether startup was accepted. Close this Environment from ChatGPT if it does not start."
    : "Your temporary runner and T3 Code are starting.";
  return page(
    "Preparing private development environment",
    `<p>${escapeHtml(preparing)}</p>${runLink}`,
    '<meta http-equiv="refresh" content="10">',
  );
}

export async function completeEnvironmentAuthorization(
  env,
  authorization,
  fetchImpl = fetch,
  logger = console,
) {
  let token;
  let scopedToken;
  try {
    token = await exchangeGitHubUserCode(
      env,
      authorization.code,
      authorization.callback,
      authorization.codeVerifier,
      fetchImpl,
    );
    scopedToken = await scopeGitHubUserToken(
      env,
      token.access_token,
      fetchImpl,
    );
  } catch {
    logger.error("Environment GitHub token exchange failed");
    return new Response("GitHub token exchange failed", { status: 502 });
  }

  let profile;
  try {
    profile = await requestGitHubUserProfile(token.access_token, fetchImpl);
  } catch {
    logger.error("Environment GitHub profile lookup failed");
    return new Response("GitHub profile lookup failed", { status: 502 });
  }

  const origin = new URL(authorization.callback).origin;
  const session = await sealSession(
    {
      githubUserId: String(profile.id),
      githubAccessToken: scopedToken.token,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL,
    },
    env.ENVIRONMENT_SESSION_SECRET,
  );
  const response = noStoreRedirect(`${origin}/environment`);
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${session}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL}`,
  );
  return response;
}

function page(title, body, head = "") {
  const response = new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui;max-width:38rem;margin:4rem auto;padding:0 1.25rem}a{color:inherit}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    { status: 200 },
  );
  secureHeaders(response.headers);
  response.headers.set("content-type", "text/html; charset=utf-8");
  response.headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  return response;
}

function noStoreRedirect(location) {
  const response = new Response(null, {
    status: 302,
    headers: { location },
  });
  secureHeaders(response.headers);
  response.headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  return response;
}

function secureHeaders(headers) {
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
}

async function sealSession(payload, secret) {
  if (!secret) throw new Error("Environment session secret is not configured");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(secret, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: SESSION_CONTEXT },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${SESSION_VERSION}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function readSession(value, secret) {
  if (!value || !secret) return undefined;
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (
    version !== SESSION_VERSION ||
    !encodedIv ||
    !encodedCiphertext ||
    extra !== undefined
  ) return undefined;
  let plaintext;
  try {
    const key = await sessionKey(secret, ["decrypt"]);
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(encodedIv),
        additionalData: SESSION_CONTEXT,
      },
      key,
      fromBase64Url(encodedCiphertext),
    );
  } catch {
    return undefined;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (
      typeof payload.githubUserId !== "string" ||
      typeof payload.githubAccessToken !== "string" ||
      payload.githubAccessToken.length === 0 ||
      !Number.isInteger(payload.expiresAt) ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

async function sessionKey(secret, usages) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    usages,
  );
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function cookieValue(header, name) {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
