import {
  clearGitHubAuthorizationCookie,
  consumeGitHubAuthorization,
  GitHubAuthorizationStateError,
  startGitHubAuthorization,
} from "./github-oauth-state.js";
import {
  consumeAuthorizationState,
  putAuthorizationState,
} from "./authorization-state.js";
import { completeGitHubUserAuthorization } from "./github-user-auth.js";
import { consentScopes, describeScopes } from "./oauth-scopes.js";
import { completeInstallationAuthorization } from "./repository-authorization.js";

const CONSENT_TTL = 600;
const CONSENT_COOKIE = "__Host-RUNNER_CSRF";
const GITHUB_AUTHORIZATION_ORIGIN = "https://github.com";

export async function authorizePage(request, env) {
  let authRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!isAuthorizationError(error)) throw error;
    return authorizationErrorResponse(error);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return html("Authorization error", "<p>Unknown OAuth client.</p>", 400);

  let scopeDetails;
  try {
    authRequest = {
      ...authRequest,
      scope: consentScopes(authRequest.scope),
    };
    scopeDetails = describeScopes(authRequest.scope);
  } catch {
    return html("Authorization error", "<p>Invalid permission request.</p>", 400);
  }

  const csrf = crypto.randomUUID();
  const browserSession =
    cookieValue(request.headers.get("cookie"), CONSENT_COOKIE) ?? crypto.randomUUID();
  await putAuthorizationState(
    env,
    `oauth:consent:${csrf}`,
    {
      authRequest,
      browserBindingHash: await sha256Base64Url(browserSession),
    },
    CONSENT_TTL,
  );

  const scopeList = scopeDetails.length === 0
    ? "<p>No permissions were requested.</p>"
    : renderScopeGroups(scopeDetails);
  return html(
    "Authorize Harness X Harness Task Runner",
    `<p><strong>${escapeHtml(client.clientName ?? "MCP client")}</strong> requests permission to use Harness X Harness Task Runner.</p>
     <p class="note">These permissions control what ChatGPT can ask Harness to do. They do not install the GitHub App or grant access to every repository.</p>
     <h2>Requested permissions</h2>
     ${scopeList}
     <p class="note">GitHub verifies your identity next. If a task later needs a repository that the GitHub App cannot access, GitHub asks you to install or update the App for that target repository.</p>
     <form method="post" action="/authorize/consent">
       <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
       <div class="actions">
         <button class="primary" type="submit" name="decision" value="allow">Continue with GitHub</button>
         <button type="submit" name="decision" value="deny">Cancel</button>
       </div>
     </form>`,
    200,
    [secureCookie(CONSENT_COOKIE, browserSession)],
    [new URL(authRequest.redirectUri).origin, GITHUB_AUTHORIZATION_ORIGIN],
  );
}

function renderScopeGroups(scopeDetails) {
  const groups = new Map();
  for (const detail of scopeDetails) {
    const scopes = groups.get(detail.group) ?? [];
    scopes.push(detail);
    groups.set(detail.group, scopes);
  }
  return [...groups].map(([group, scopes]) =>
    `<section class="permission-group"><h3>${escapeHtml(group)}</h3><ul class="scopes">${scopes.map(({ scope, title, description }) =>
      `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span><code>${escapeHtml(scope)}</code></li>`
    ).join("")}</ul></section>`
  ).join("");
}

export async function submitAuthorizationDecision(request, env) {
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  const browserSession = cookieValue(request.headers.get("cookie"), CONSENT_COOKIE);
  if (!csrf || !browserSession) {
    return html("Authorization error", "<p>Invalid consent state.</p>", 400);
  }

  const consent = await consumeAuthorizationState(
    env,
    `oauth:consent:${csrf}`,
    await sha256Base64Url(browserSession),
  );
  if (consent.kind === "missing") {
    return html("Authorization error", "<p>Expired consent state.</p>", 400);
  }
  if (consent.kind === "browser_mismatch") {
    return html("Authorization error", "<p>Invalid consent state.</p>", 400);
  }
  const decision = String(form.get("decision") ?? "");
  if (decision !== "allow" && decision !== "deny") {
    return html("Authorization error", "<p>Invalid authorization decision.</p>", 400);
  }
  const authRequest = consent.value.authRequest;

  if (decision === "deny") {
    return oauthRedirect(authRequest.redirectUri, {
      error: "access_denied",
      error_description: "The user denied the authorization request",
      state: authRequest.state,
      iss: authRequest.issuer,
    });
  }

  const callback = `${new URL(request.url).origin}/github/callback`;
  return startGitHubAuthorization(
    env,
    callback,
    { kind: "mcp", authRequest },
  );
}

export async function completeAuthorizationCallback(
  request,
  env,
  fetchImpl = fetch,
  logger = console,
) {
  let authorization;
  try {
    authorization = await consumeGitHubAuthorization(request, env);
  } catch (error) {
    if (!(error instanceof GitHubAuthorizationStateError)) throw error;
    return html("Authorization error", `<p>${escapeHtml(error.message)}.</p>`, error.status, [clearGitHubCookie()]);
  }

  let response;
  if (authorization.payload?.kind === "mcp") {
    response = await completeGitHubUserAuthorization(
      env,
      authorization,
      fetchImpl,
      logger,
    );
  } else if (authorization.payload?.kind === "installation") {
    const installationResponse = await completeInstallationAuthorization(
      env,
      authorization,
      fetchImpl,
    );
    response = await completionPage(installationResponse);
  } else {
    response = html("Authorization error", "<p>Unknown GitHub authorization request.</p>", 400);
  }
  return clearGitHubAuthorizationCookie(response);
}

async function completionPage(response) {
  const message = await response.text();
  return html(
    response.ok ? "Repository authorization complete" : "Authorization error",
    `<p>${escapeHtml(message)}</p><p>You can return to ChatGPT.</p>`,
    response.status,
  );
}

function authorizationErrorResponse(error) {
  if (!error.redirectUri) {
    return html("Authorization error", `<p>${escapeHtml(error.description)}.</p>`, 400);
  }
  return oauthRedirect(error.redirectUri, {
    error: error.code,
    error_description: error.description,
    state: error.state,
    iss: error.issuer,
  });
}

/**
 * @param {unknown} error
 * @returns {error is Error & {code: string, description: string, redirectUri?: string, state?: string, issuer?: string}}
 */
function isAuthorizationError(error) {
  if (!(error instanceof Error)) return false;
  const candidate = /** @type {Error & Record<string, unknown>} */ (error);
  return candidate.name === "AuthorizationError" &&
    typeof candidate.code === "string" &&
    typeof candidate.description === "string";
}

function oauthRedirect(redirectUri, parameters) {
  const redirect = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value) redirect.searchParams.set(name, value);
  }
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString() },
  });
}

function html(title, body, status = 200, cookies = [], formActionOrigins = []) {
  const formActions = ["'self'", ...formActionOrigins].join(" ");
  const response = new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
     <style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui;max-width:42rem;margin:4rem auto;padding:0 1.25rem}h1{line-height:1.2}h2{font-size:1.1rem;margin-top:2rem}.permission-group{margin-top:1.5rem}.permission-group h3{font-size:1rem;margin:0 0 .65rem}.scopes{list-style:none;padding:0;display:grid;gap:.75rem}.scopes li{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.6rem;padding:.8rem 1rem}.scopes span,.scopes code{display:block}.scopes span{margin:.2rem 0;color:color-mix(in srgb,currentColor 72%,transparent)}.scopes code{font-size:.8rem}.note{margin:1.5rem 0}.actions{display:flex;gap:.75rem;flex-wrap:wrap}button{font:inherit;padding:.65rem 1rem;border-radius:.45rem;border:1px solid currentColor;cursor:pointer}.primary{background:#238636;color:#fff;border-color:#238636}button:focus-visible{outline:3px solid #58a6ff;outline-offset:2px}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    { status },
  );
  const headers = response.headers;
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActions}; frame-ancestors 'none'; base-uri 'none'`,
  );
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return response;
}

function secureCookie(name, value, maxAge = CONSENT_TTL) {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function clearGitHubCookie() {
  return "__Host-RUNNER_GITHUB_STATE=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0";
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
