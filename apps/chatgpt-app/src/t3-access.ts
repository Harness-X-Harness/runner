import { z } from "zod";
import { consumeGitHubAuthorization, startGitHubAuthorization } from "./github-oauth-state.ts";
import { exchangeGitHubUserCode, requestGitHubUserProfile } from "./github-user-auth.ts";
import type { AuthorizationStateEnv } from "./authorization-state.ts";
import type { EnvironmentObject } from "./environment-object.ts";

export type T3AccessEnvironment = AuthorizationStateEnv & {
  GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string;
  ENVIRONMENTS?: { getByName(id: string): Pick<EnvironmentObject, "issueT3Pairing"> };
};

const environmentId = z.string().regex(/^env_[a-f0-9]{32}$/);

/** Browser-only entry. Authentication, owner check and pairing must all succeed. */
export async function startT3Access(request: Request, env: T3AccessEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/t3\/connect\/(env_[a-f0-9]{32})$/.exec(url.pathname);
  // Source attribution is inert and must not enter authorization state or redirects.
  const unsupportedQuery = [...url.searchParams.keys()].some(name => name !== "utm_source");
  if (request.method !== "GET" || !match || unsupportedQuery || url.hash) {
    return new Response(null, { status: 404 });
  }
  const id = environmentId.parse(match[1]);
  return startGitHubAuthorization(env, new URL("/github/callback", url.origin).toString(),
    { kind: "t3", environmentId: id }, "t3_github_");
}

/** Reuse existing PKCE + browser-bound GitHub identity. Do not issue a workflow token. */
export async function completeT3Access(
  authorization: Awaited<ReturnType<typeof consumeGitHubAuthorization>> & {
    payload: { kind: "t3"; environmentId: string };
  },
  env: T3AccessEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let ownerId: string;
  try {
    const token = await exchangeGitHubUserCode(env, authorization.code, authorization.callback,
      authorization.codeVerifier, fetchImpl);
    const profile = await requestGitHubUserProfile(token.access_token, fetchImpl);
    ownerId = String(profile.id);
  } catch {
    return new Response("GitHub identity verification failed.", { status: 502 });
  }
  let pairUrl: string;
  try {
    const id = environmentId.parse(authorization.payload.environmentId);
    if (!env.ENVIRONMENTS) throw new Error("T3_PAIRING_UNAVAILABLE");
    pairUrl = await env.ENVIRONMENTS.getByName(id).issueT3Pairing(ownerId);
  } catch {
    // Do not disclose existence, ownership or native pairing credentials.
    return new Response("T3 access unavailable.", { status: 403 });
  }
  // The fragment stays client-side when navigating to T3's native pairing UI.
  return new Response(null, { status: 302, headers: {
    location: pairUrl,
    "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  } });
}
