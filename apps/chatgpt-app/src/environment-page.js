import { readEnvironment, reconcileEnvironment } from "./environment.js";
import { getEnvironmentWorkflowRun } from "./github.js";
import { startGitHubAuthorization } from "./github-oauth-state.js";
import {
  exchangeGitHubUserCode,
  requestGitHubUserProfile,
} from "./github-user-auth.js";

const SESSION_COOKIE = "__Host-RUNNER_ENVIRONMENT";
const SESSION_TTL = 6 * 60 * 60;

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
      observeRun,
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
  try {
    token = await exchangeGitHubUserCode(
      env,
      authorization.code,
      authorization.callback,
      authorization.codeVerifier,
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
  const session = await signSession(
    {
      githubUserId: String(profile.id),
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

async function signSession(payload, secret) {
  if (!secret) throw new Error("Environment session secret is not configured");
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac("sign", secret, `session:${encoded}`);
  return `${encoded}.${base64Url(new Uint8Array(/** @type {ArrayBuffer} */ (signature)))}`;
}

async function readSession(value, secret) {
  if (!value || !secret) return undefined;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra !== undefined) return undefined;
  let valid;
  try {
    valid = await hmac("verify", secret, `session:${encoded}`, fromBase64Url(signature));
  } catch {
    return undefined;
  }
  if (!valid) return undefined;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encoded)),
    );
    if (
      typeof payload.githubUserId !== "string" ||
      !Number.isInteger(payload.expiresAt) ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

async function hmac(operation, secret, value, signature) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [operation],
  );
  if (operation === "sign") {
    return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  }
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(value),
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
