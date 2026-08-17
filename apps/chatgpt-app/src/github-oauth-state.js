import { githubUserAuthorizationUrl } from "./github-user-auth.js";
import {
  consumeAuthorizationState,
  putAuthorizationState,
} from "./authorization-state.js";

const STATE_TTL = 600;
const STATE_COOKIE = "__Host-RUNNER_GITHUB_STATE";

export class GitHubAuthorizationStateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function startGitHubAuthorization(
  env,
  callback,
  payload,
  statePrefix = "github_oauth_",
) {
  const state = `${statePrefix}${crypto.randomUUID()}`;
  const codeVerifier = randomBase64Url(32);
  const browserBinding = randomBase64Url(32);
  const [codeChallenge, browserBindingHash] = await Promise.all([
    sha256Base64Url(codeVerifier),
    sha256Base64Url(browserBinding),
  ]);
  await putAuthorizationState(
    env,
    `github:oauth:${state}`,
    { payload, codeVerifier, browserBindingHash },
    STATE_TTL,
  );

  const response = new Response(null, {
    status: 302,
    headers: {
      location: githubUserAuthorizationUrl(env, callback, state, codeChallenge).toString(),
    },
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("pragma", "no-cache");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.headers.append("set-cookie", secureCookie(STATE_COOKIE, browserBinding));
  return response;
}

export async function consumeGitHubAuthorization(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    throw new GitHubAuthorizationStateError("GitHub authorization was not completed");
  }

  const browserBinding = cookieValue(request.headers.get("cookie"), STATE_COOKIE);
  const record = await consumeAuthorizationState(
    env,
    `github:oauth:${state}`,
    browserBinding ? await sha256Base64Url(browserBinding) : "",
  );
  if (record.kind === "missing") {
    throw new GitHubAuthorizationStateError("Expired GitHub authorization state");
  }
  if (record.kind === "browser_mismatch") {
    throw new GitHubAuthorizationStateError("GitHub authorization browser state did not match");
  }

  return {
    callback: `${url.origin}/github/callback`,
    code,
    codeVerifier: record.value.codeVerifier,
    payload: record.value.payload,
  };
}

export function clearGitHubAuthorizationCookie(response) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", secureCookie(STATE_COOKIE, "", 0));
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function secureCookie(name, value, maxAge = STATE_TTL) {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
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

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
