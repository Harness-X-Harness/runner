import {
  clearGitHubAuthorizationCookie,
  consumeGitHubAuthorization,
  GitHubAuthorizationStateError,
  startGitHubAuthorization,
} from "./github-oauth-state.ts";
import {
  consumeAuthorizationState,
  putAuthorizationState,
} from "./authorization-state.ts";
import { completeGitHubUserAuthorization } from "./github-user-auth.ts";
import { consentScopes, describeScopes } from "./oauth-scopes.ts";
import type { AuthorizationStateEnv } from "./authorization-state.ts";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ReactNode } from "react";
import { authorizationDocument, consentView, paragraph } from "./authorization-view.ts";

export type AuthorizationEnvironment = AuthorizationStateEnv & Parameters<typeof completeGitHubUserAuthorization>[0] & {
  OAUTH_PROVIDER: Pick<OAuthHelpers, "parseAuthRequest" | "lookupClient" | "completeAuthorization">;
};
type ScopeDetails = ReturnType<typeof describeScopes>;
type AuthorizationFailure = Error & {
  code: string; description: string; redirectUri?: string; state?: string; issuer?: string;
};

const CONSENT_TTL = 600;
const CONSENT_COOKIE = "__Host-RUNNER_CSRF";
const GITHUB_AUTHORIZATION_ORIGIN = "https://github.com";

export async function authorizePage(request: Request, env: AuthorizationEnvironment): Promise<Response> {
  let authRequest: AuthRequest;
  let client: ClientInfo | null;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  } catch (error) {
    if (isCimdFetchError(error)) {
      return html(
        "Authorization temporarily unavailable",
        [paragraph("Harness could not verify your MCP client's public metadata. No authorization was granted."), paragraph("The service operator must resolve the metadata lookup failure before you can connect.")],
        503,
      );
    }
    if (!isAuthorizationError(error)) throw error;
    return authorizationErrorResponse(error);
  }
  if (!client) return html("Authorization error", paragraph("Unknown OAuth client."), 400);

  let scopeDetails: ScopeDetails;
  try {
    authRequest = {
      ...authRequest,
      scope: consentScopes(authRequest.scope),
    };
    scopeDetails = describeScopes(authRequest.scope);
  } catch {
    return html("Authorization error", paragraph("Invalid permission request."), 400);
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

  return html(
    "Authorize Harness X Harness",
    consentView(client.clientName ?? "MCP client", csrf, scopeDetails),
    200,
    [secureCookie(CONSENT_COOKIE, browserSession)],
    [new URL(authRequest.redirectUri).origin, GITHUB_AUTHORIZATION_ORIGIN],
  );
}

export async function submitAuthorizationDecision(request: Request, env: AuthorizationEnvironment): Promise<Response> {
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  const browserSession = cookieValue(request.headers.get("cookie"), CONSENT_COOKIE);
  if (!csrf || !browserSession) {
    return html("Authorization error", paragraph("Invalid consent state."), 400);
  }

  const consent = await consumeAuthorizationState(
    env,
    `oauth:consent:${csrf}`,
    await sha256Base64Url(browserSession),
  );
  if (consent.kind === "missing") {
    return html("Authorization error", paragraph("Expired consent state."), 400);
  }
  if (consent.kind === "browser_mismatch") {
    return html("Authorization error", paragraph("Invalid consent state."), 400);
  }
  const decision = String(form.get("decision") ?? "");
  if (decision !== "allow" && decision !== "deny") {
    return html("Authorization error", paragraph("Invalid authorization decision."), 400);
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
    {
      kind: "mcp",
      authRequest,
    },
  );
}

export async function completeAuthorizationCallback(
  request: Request,
  env: AuthorizationEnvironment,
  fetchImpl = fetch,
  logger: Pick<Console, "error"> = console,
): Promise<Response> {
  let authorization;
  try {
    authorization = await consumeGitHubAuthorization(request, env);
  } catch (error) {
    if (!(error instanceof GitHubAuthorizationStateError)) throw error;
    return html("Authorization error", paragraph(`${error.message}.`), error.status, [clearGitHubCookie()]);
  }

  let response;
  if (authorization.payload?.kind === "mcp") {
    response = await completeGitHubUserAuthorization(
      env,
      authorization,
      fetchImpl,
      logger,
    );
  } else {
    response = html("Authorization error", paragraph("Unknown GitHub authorization request."), 400);
  }
  return clearGitHubAuthorizationCookie(response);
}

function authorizationErrorResponse(error: AuthorizationFailure): Response {
  if (!error.redirectUri) {
    return html("Authorization error", paragraph(`${error.description}.`), 400);
  }
  return oauthRedirect(error.redirectUri, {
    error: error.code,
    error_description: error.description,
    state: error.state,
    iss: error.issuer,
  });
}

function isAuthorizationError(error: unknown): error is AuthorizationFailure {
  if (!(error instanceof Error)) return false;
  return error.name === "AuthorizationError" &&
    "code" in error && typeof error.code === "string" &&
    "description" in error && typeof error.description === "string" &&
    (!("redirectUri" in error) || error.redirectUri === undefined || typeof error.redirectUri === "string") &&
    (!("state" in error) || error.state === undefined || typeof error.state === "string") &&
    (!("issuer" in error) || error.issuer === undefined || typeof error.issuer === "string");
}

function isCimdFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "CimdFetchError" && "reason" in error &&
    error.reason === "metadata_resolution_failed";
}

function oauthRedirect(redirectUri: string, parameters: Record<string, string | undefined>): Response {
  const redirect = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value) redirect.searchParams.set(name, value);
  }
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString() },
  });
}

function html(title: string, body: ReactNode, status = 200, cookies: string[] = [], formActionOrigins: string[] = []): Response {
  const formActions = ["'self'", ...formActionOrigins].join(" ");
  const response = new Response(
    authorizationDocument(title, body),
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
    `default-src 'none'; style-src 'self' 'unsafe-inline'; form-action ${formActions}; frame-ancestors 'none'; base-uri 'none'`,
  );
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return response;
}

function secureCookie(name: string, value: string, maxAge = CONSENT_TTL): string {
  return `${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

async function sha256Base64Url(value: string): Promise<string> {
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

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}
