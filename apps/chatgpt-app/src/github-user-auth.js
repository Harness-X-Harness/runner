import { githubHeaders } from "./github.js";
import { OAUTH_SCOPES } from "./oauth-scopes.js";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const MINIMUM_TOKEN_TTL = 60;
const AUTHORIZATION_KIND = "github_app_scoped";

export function githubUserAuthorizationUrl(env, callback, state, codeChallenge) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function exchangeGitHubUserCode(
  env,
  code,
  callback,
  codeVerifier,
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
  env,
  accessToken,
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
  const scoped = await response.json().catch(() => undefined);
  if (!response.ok || typeof scoped?.token !== "string") {
    throw new Error("GitHub user token scoping failed");
  }
  return scoped;
}

export async function completeGitHubUserAuthorization(
  env,
  githubAuthorization,
  fetchImpl = fetch,
  logger = console,
) {
  const { authRequest } = githubAuthorization.payload;
  let token;
  let scopedToken;
  try {
    token = await exchangeGitHubUserCode(
      env,
      githubAuthorization.code,
      githubAuthorization.callback,
      githubAuthorization.codeVerifier,
      fetchImpl,
    );
    scopedToken = await scopeGitHubUserToken(env, token.access_token, fetchImpl);
  } catch {
    return new Response("GitHub token exchange failed", { status: 502 });
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
        mcpControllerGrantId: controllerGrantId(githubAuthorization.payload),
        mcpClientName: controllerClientName(githubAuthorization.payload),
        ...githubUserTokenProps(token, scopedToken),
      },
    });
  } catch (error) {
    logger.error("GitHub OAuth grant completion failed", error);
    return new Response("OAuth grant creation failed", { status: 502 });
  }
  return Response.redirect(authorization.redirectTo, 302);
}

function controllerGrantId(payload) {
  const value = payload?.controllerGrantId;
  if (typeof value !== "string" || !/^grant_[A-Za-z0-9-]{1,120}$/.test(value)) {
    throw new Error("MCP controller identity is invalid");
  }
  return value;
}

function controllerClientName(payload) {
  const value = payload?.clientName;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("MCP client identity is invalid");
  }
  return value;
}

export async function refreshGitHubUserToken(
  env,
  refreshToken,
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
  env,
  options,
  fetchImpl = fetch,
  now = currentUnixTime,
) {
  requireScopedAuthority(options.props);
  const currentTime = now();
  if (options.grantType === "authorization_code") {
    const accessTokenTTL = remainingLifetime(
      options.props.environmentGithubAccessTokenExpiresAt,
      currentTime,
    );
    if (accessTokenTTL !== undefined && accessTokenTTL < MINIMUM_TOKEN_TTL) {
      return rotateGitHubUserToken(env, options.props, fetchImpl, currentTime, true);
    }
    return compact({
      accessTokenTTL,
      refreshTokenTTL: remainingLifetime(
        options.props.githubRefreshTokenExpiresAt,
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
  env,
  props,
  fetchImpl,
  currentTime,
  includeRefreshTokenTTL,
) {
  if (!props.githubRefreshToken) {
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
    ...props,
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
  token,
  scopedToken,
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

async function requestGitHubUserToken(parameters, fetchImpl) {
  const response = await fetchImpl(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters).toString(),
  });
  const token = await response.json().catch(() => undefined);
  if (!response.ok || !token?.access_token) {
    throw new Error("GitHub user token exchange failed");
  }
  return token;
}

export async function requestGitHubUserProfile(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: githubHeaders(accessToken),
  });
  const profile = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    !Number.isInteger(profile?.id) ||
    typeof profile?.login !== "string"
  ) {
    throw new Error("GitHub user profile lookup failed");
  }
  return profile;
}

function requireScopedAuthority(props) {
  if (
    props?.githubAuthorizationKind !== AUTHORIZATION_KIND ||
    typeof props.environmentGithubAccessToken !== "string" ||
    props.environmentGithubAccessToken.length === 0
  ) {
    throw new Error("GitHub user authorization must be reconnected");
  }
}

function runnerRepository(env) {
  const parts = env.GITHUB_RUNNER_REPOSITORY.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("GitHub runner repository is invalid");
  }
  return parts;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function expirationTime(issuedAt, lifetime) {
  return positiveInteger(lifetime) ? issuedAt + lifetime : undefined;
}

function absoluteExpiration(value) {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? Math.floor(milliseconds / 1000)
    : undefined;
}

function remainingLifetime(expiresAt, currentTime) {
  if (!positiveInteger(expiresAt)) return undefined;
  return Math.max(0, expiresAt - currentTime);
}

function minimumLifetime(values) {
  const defined = values.filter((value) => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function currentUnixTime() {
  return Math.floor(Date.now() / 1000);
}
