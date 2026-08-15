import { githubHeaders } from "./github.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const MINIMUM_TOKEN_TTL = 60;

export const OAUTH_SCOPES = Object.freeze([
  "tasks:read",
  "tasks:run",
  "tasks:cancel",
  "repos:read",
  "repos:write",
  "pull_requests:write",
]);

export function githubUserAuthorizationUrl(env, callback, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("state", state);
  return url;
}

export async function exchangeGitHubUserCode(
  env,
  code,
  callback,
  fetchImpl = fetch,
) {
  return requestGitHubUserToken(
    {
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: callback,
    },
    fetchImpl,
  );
}

export async function completeGitHubUserAuthorization(
  request,
  env,
  fetchImpl = fetch,
  logger = console,
) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    return new Response("GitHub authorization was not completed", {
      status: 400,
    });
  }

  const authRequestJson = await env.OAUTH_KV.get(`oauth:github:${state}`);
  if (!authRequestJson) {
    return new Response("Expired GitHub authorization state", { status: 400 });
  }
  await env.OAUTH_KV.delete(`oauth:github:${state}`);

  const callback = `${url.origin}/github/callback`;
  let token;
  try {
    token = await exchangeGitHubUserCode(env, code, callback, fetchImpl);
  } catch {
    return new Response("GitHub token exchange failed", { status: 502 });
  }

  let profile;
  try {
    profile = await requestGitHubUserProfile(token.access_token, fetchImpl);
  } catch {
    return new Response("GitHub profile lookup failed", { status: 502 });
  }
  const authRequest = JSON.parse(authRequestJson);
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
        ...githubUserTokenProps(token),
      },
    });
  } catch (error) {
    logger.error("GitHub OAuth grant completion failed", error);
    return new Response("OAuth grant creation failed", { status: 502 });
  }
  return Response.redirect(authorization.redirectTo, 302);
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
  const currentTime = now();
  if (options.grantType === "authorization_code") {
    const accessTokenTTL = remainingLifetime(
      options.props.githubAccessTokenExpiresAt,
      currentTime,
    );
    if (
      options.props.githubAccessTokenExpiresAt !== undefined &&
      (accessTokenTTL ?? 0) < MINIMUM_TOKEN_TTL
    ) {
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
  const newProps = {
    ...props,
    ...githubUserTokenProps(token, currentTime),
  };
  return {
    newProps,
    ...(positiveInteger(token.expires_in)
      ? { accessTokenTTL: token.expires_in }
      : {}),
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

export function githubUserTokenProps(token, issuedAt = currentUnixTime()) {
  return compact({
    githubAccessToken: token.access_token,
    githubRefreshToken: token.refresh_token,
    githubAccessTokenExpiresAt: expirationTime(issuedAt, token.expires_in),
    githubRefreshTokenExpiresAt: expirationTime(
      issuedAt,
      token.refresh_token_expires_in,
    ),
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

async function requestGitHubUserProfile(accessToken, fetchImpl) {
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

function remainingLifetime(expiresAt, currentTime) {
  if (!positiveInteger(expiresAt)) return undefined;
  return Math.max(0, expiresAt - currentTime);
}

function currentUnixTime() {
  return Math.floor(Date.now() / 1000);
}
