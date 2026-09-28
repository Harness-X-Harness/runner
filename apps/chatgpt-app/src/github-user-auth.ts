import { githubHeaders } from "./github.ts";
import { OAUTH_SCOPES } from "./oauth-scopes.ts";
import { z } from "zod";
import type { OAuthHelpers, TokenExchangeCallbackOptions, TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import type { consumeGitHubAuthorization } from "./github-oauth-state.ts";

type AppCredentials = { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string };
type GitHubEnv = AppCredentials & { GITHUB_RUNNER_REPOSITORY: string };
type AuthorizationEnv = GitHubEnv & { OAUTH_PROVIDER: Pick<OAuthHelpers, "completeAuthorization"> };
type ScopedProps = Record<string, unknown> & {
  githubAuthorizationKind: "github_app_scoped";
  environmentGithubAccessToken: string;
};
const tokenSchema = z.looseObject({
  access_token: z.string().min(1), refresh_token: z.string().optional(),
  expires_in: z.unknown().optional(), refresh_token_expires_in: z.unknown().optional(),
});
const scopedTokenSchema = z.looseObject({ token: z.string(), expires_at: z.unknown().optional() });
const profileSchema = z.looseObject({ id: z.number().int(), login: z.string() });
type GitHubToken = z.infer<typeof tokenSchema>;
type ScopedToken = z.infer<typeof scopedTokenSchema>;

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const MINIMUM_TOKEN_TTL = 60;
const AUTHORIZATION_KIND = "github_app_scoped";
const SAFE_OAUTH_ERRORS = new Set([
  "incorrect_client_credentials", "redirect_uri_mismatch",
  "bad_verification_code", "unverified_user_email",
]);

class GitHubTokenError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(message: string, response: Response, body: unknown) {
    super(message);
    this.status = response.status;
    const reason = body && typeof body === "object" && "error" in body ? body.error : undefined;
    this.reason = !body ? "invalid_response"
      : typeof reason === "string" && SAFE_OAUTH_ERRORS.has(reason) ? reason : "upstream_rejected";
  }
}

export function githubUserAuthorizationUrl(
  env: Pick<AppCredentials, "GITHUB_APP_CLIENT_ID">, callback: string, state: string, codeChallenge: string,
): URL {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function exchangeGitHubUserCode(
  env: AppCredentials,
  code: string,
  callback: string,
  codeVerifier: string,
  fetchImpl = fetch,
) {
  return requestGitHubUserToken(
    {
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: callback,
      code_verifier: codeVerifier,
    },
    fetchImpl,
  );
}

export async function scopeGitHubUserToken(
  env: GitHubEnv,
  accessToken: string,
  fetchImpl = fetch,
) {
  const [owner, repository] = runnerRepository(env);
  const credentials = btoa(
    `${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`,
  );
  const response = await fetchImpl(
    `${API}/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/token/scoped`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${credentials}`,
        "content-type": "application/json",
        "user-agent": "HarnessXHarness",
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify({
        access_token: accessToken,
        target: owner,
        repositories: [repository],
        permissions: { actions: "write" },
      }),
    },
  );
  const scoped: unknown = await response.json().catch(() => undefined);
  const parsed = scopedTokenSchema.safeParse(scoped);
  if (!response.ok || !parsed.success) {
    throw new GitHubTokenError("GitHub user token scoping failed", response, scoped);
  }
  return parsed.data;
}

export async function completeGitHubUserAuthorization(
  env: AuthorizationEnv,
  githubAuthorization: Awaited<ReturnType<typeof consumeGitHubAuthorization>>,
  fetchImpl = fetch,
  logger: Pick<Console, "error"> = console,
): Promise<Response> {
  const { authRequest } = githubAuthorization.payload;
  let token: GitHubToken;
  let scopedToken: ScopedToken;
  let stage = "code_exchange";
  try {
    token = await exchangeGitHubUserCode(
      env,
      githubAuthorization.code,
      githubAuthorization.callback,
      githubAuthorization.codeVerifier,
      fetchImpl,
    );
    stage = "token_scoping";
    scopedToken = await scopeGitHubUserToken(env, token.access_token, fetchImpl);
  } catch (error) {
    const detail = error instanceof GitHubTokenError
      ? { status: error.status, reason: error.reason }
      : { reason: "request_failed" };
    // Never log the raw exception, request, token, or upstream response body.
    logger.error("GitHub authorization failed", { stage, ...detail });
    const title = stage === "code_exchange"
      ? "GitHub token exchange failed" : "GitHub workflow token scoping failed";
    const status = "status" in detail ? `HTTP ${detail.status}; ` : "";
    return new Response(`${title} (${status}${detail.reason}).`, { status: 502 });
  }

  let profile;
  try {
    profile = await requestGitHubUserProfile(token.access_token, fetchImpl);
  } catch {
    return new Response("GitHub profile lookup failed", { status: 502 });
  }
  const grantedScopes = authRequest.scope.filter((scope) =>
    OAUTH_SCOPES.includes(scope),
  );
  let authorization;
  try {
    authorization = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: `github-${profile.id}`,
      metadata: { githubLogin: profile.login },
      scope: grantedScopes,
      props: {
        githubUserId: profile.id,
        githubLogin: profile.login,
        oauthScopes: grantedScopes,
        ...githubUserTokenProps(token, scopedToken),
      },
    });
  } catch {
    logger.error("GitHub OAuth grant completion failed", { reason: "grant_completion_failed" });
    return new Response("OAuth grant creation failed", { status: 502 });
  }
  return Response.redirect(authorization.redirectTo, 302);
}

export async function refreshGitHubUserToken(
  env: AppCredentials,
  refreshToken: string,
  fetchImpl = fetch,
) {
  return requestGitHubUserToken(
    {
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
}

export async function githubGrantTokenExchange(
  env: GitHubEnv,
  options: Pick<TokenExchangeCallbackOptions, "grantType"> & { props: unknown },
  fetchImpl = fetch,
  now = currentUnixTime,
): Promise<TokenExchangeCallbackResult | undefined> {
  requireScopedAuthority(options.props);
  const currentTime = now();
  if (options.grantType === "authorization_code") {
    const newProps = withoutLegacyBaseAccessToken(options.props);
    const accessTokenTTL = remainingLifetime(
      newProps.environmentGithubAccessTokenExpiresAt,
      currentTime,
    );
    if (accessTokenTTL !== undefined && accessTokenTTL < MINIMUM_TOKEN_TTL) {
      return rotateGitHubUserToken(env, newProps, fetchImpl, currentTime, true);
    }
    return compact({
      ...(newProps !== options.props ? { newProps } : {}),
      accessTokenTTL,
      refreshTokenTTL: remainingLifetime(
        newProps.githubRefreshTokenExpiresAt,
        currentTime,
      ),
    });
  }

  if (options.grantType !== "refresh_token" || !options.props.githubRefreshToken) {
    return undefined;
  }

  return rotateGitHubUserToken(
    env,
    options.props,
    fetchImpl,
    currentTime,
    false,
  );
}

async function rotateGitHubUserToken(
  env: GitHubEnv,
  props: ScopedProps,
  fetchImpl: typeof fetch,
  currentTime: number,
  includeRefreshTokenTTL: boolean,
): Promise<TokenExchangeCallbackResult> {
  if (typeof props.githubRefreshToken !== "string" || !props.githubRefreshToken) {
    throw new Error("GitHub user authorization expired");
  }
  const token = await refreshGitHubUserToken(
    env,
    props.githubRefreshToken,
    fetchImpl,
  );
  const scopedToken = await scopeGitHubUserToken(
    env,
    token.access_token,
    fetchImpl,
  );
  const newProps = {
    ...withoutLegacyBaseAccessToken(props),
    ...githubUserTokenProps(token, scopedToken, currentTime),
  };
  const accessTokenTTL = minimumLifetime([
    positiveInteger(token.expires_in) ? token.expires_in : undefined,
    remainingLifetime(
      newProps.environmentGithubAccessTokenExpiresAt,
      currentTime,
    ),
  ]);
  return {
    newProps,
    ...compact({ accessTokenTTL }),
    ...(includeRefreshTokenTTL
      ? compact({
          refreshTokenTTL: remainingLifetime(
            newProps.githubRefreshTokenExpiresAt,
            currentTime,
          ),
        })
      : {}),
  };
}

export function githubUserTokenProps(
  token: GitHubToken,
  scopedToken: ScopedToken,
  issuedAt = currentUnixTime(),
) {
  return compact({
    githubRefreshToken: token.refresh_token,
    githubRefreshTokenExpiresAt: expirationTime(
      issuedAt,
      token.refresh_token_expires_in,
    ),
    environmentGithubAccessToken: scopedToken.token,
    environmentGithubAccessTokenExpiresAt: absoluteExpiration(
      scopedToken.expires_at,
    ),
    githubAuthorizationKind: AUTHORIZATION_KIND,
  });
}

async function requestGitHubUserToken(parameters: Record<string, string>, fetchImpl: typeof fetch): Promise<GitHubToken> {
  const response = await fetchImpl(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters).toString(),
  });
  const token: unknown = await response.json().catch(() => undefined);
  const parsed = tokenSchema.safeParse(token);
  if (!response.ok || !parsed.success) {
    throw new GitHubTokenError("GitHub user token exchange failed", response, token);
  }
  return parsed.data;
}

export async function requestGitHubUserProfile(accessToken: string, fetchImpl = fetch) {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: githubHeaders(accessToken),
  });
  const profile: unknown = await response.json().catch(() => undefined);
  const parsed = profileSchema.safeParse(profile);
  if (
    !response.ok ||
    !parsed.success
  ) {
    throw new Error("GitHub user profile lookup failed");
  }
  return parsed.data;
}

function requireScopedAuthority(props: unknown): asserts props is ScopedProps {
  if (
    !props || typeof props !== "object" || !("githubAuthorizationKind" in props) ||
    props.githubAuthorizationKind !== AUTHORIZATION_KIND || !("environmentGithubAccessToken" in props) ||
    typeof props.environmentGithubAccessToken !== "string" ||
    props.environmentGithubAccessToken.length === 0
  ) {
    throw new Error("GitHub user authorization must be reconnected");
  }
}

function runnerRepository(env: Pick<GitHubEnv, "GITHUB_RUNNER_REPOSITORY">): string[] {
  const parts = env.GITHUB_RUNNER_REPOSITORY.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("GitHub runner repository is invalid");
  }
  return parts;
}

function compact<T extends object>(value: T): T {
  const result = { ...value };
  for (const key in result) if (result[key] === undefined) delete result[key];
  return result;
}

function withoutLegacyBaseAccessToken(props: ScopedProps): ScopedProps {
  if (
    !Object.hasOwn(props, "githubAccessToken") &&
    !Object.hasOwn(props, "githubAccessTokenExpiresAt")
  ) return props;
  const {
    githubAccessToken: _accessToken,
    githubAccessTokenExpiresAt: _accessTokenExpiresAt,
    ...current
  } = props;
  return current;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function expirationTime(issuedAt: number, lifetime: unknown): number | undefined {
  return positiveInteger(lifetime) ? issuedAt + lifetime : undefined;
}

function absoluteExpiration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1000)
    : undefined;
}

function remainingLifetime(expiresAt: unknown, currentTime: number): number | undefined {
  if (!positiveInteger(expiresAt)) return undefined;
  return Math.max(0, expiresAt - currentTime);
}

function minimumLifetime(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value) => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function currentUnixTime() {
  return Math.floor(Date.now() / 1000);
}
