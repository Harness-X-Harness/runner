import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeGitHubUserAuthorization,
  exchangeGitHubUserCode,
  githubGrantTokenExchange,
  githubUserAuthorizationUrl,
  githubUserTokenProps,
  scopeGitHubUserToken,
} from "../apps/chatgpt-app/src/github-user-auth.js";

const appEnv = (overrides = {}) => ({
  GITHUB_APP_CLIENT_ID: "Iv1.example",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
  ...overrides,
});

test("GitHub App authorization uses S256 PKCE without a broad OAuth scope", () => {
  const url = githubUserAuthorizationUrl(
    appEnv(),
    "https://runner.example.com/github/callback",
    "state-123",
    "challenge-123",
  );

  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv1.example");
  assert.equal(url.searchParams.get("redirect_uri"), "https://runner.example.com/github/callback");
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("GitHub App callback exchanges its code with App credentials", async () => {
  let captured;
  const token = await exchangeGitHubUserCode(
    appEnv(),
    "callback-code",
    "https://runner.example.com/github/callback",
    "verifier-123",
    async (url, init) => {
      captured = { url, init };
      return Response.json({ access_token: "ghu_access" });
    },
  );

  assert.equal(captured.url, "https://github.com/login/oauth/access_token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(captured.init.body)), {
    client_id: "Iv1.example",
    client_secret: "client-secret",
    code: "callback-code",
    redirect_uri: "https://runner.example.com/github/callback",
    code_verifier: "verifier-123",
  });
  assert.equal(token.access_token, "ghu_access");
});

test("Environment token is scoped to one runner repository and Actions write", async () => {
  let captured;
  const token = await scopeGitHubUserToken(appEnv(), "ghu_base", async (url, init) => {
    captured = { url, init };
    return Response.json({ token: "ghu_scoped", expires_at: "2030-01-01T00:00:00Z" });
  });

  assert.equal(captured.url, "https://api.github.com/applications/Iv1.example/token/scoped");
  assert.equal(captured.init.method, "POST");
  assert.equal(
    Buffer.from(captured.init.headers.authorization.slice(6), "base64").toString(),
    "Iv1.example:client-secret",
  );
  assert.deepEqual(JSON.parse(captured.init.body), {
    access_token: "ghu_base",
    target: "Harness-X-Harness",
    repositories: ["runner"],
    permissions: { actions: "write" },
  });
  assert.equal(token.token, "ghu_scoped");
});

test("GitHub callback stores base and scoped authority in one Principal grant", async () => {
  const authRequest = {
    responseType: "code",
    clientId: "client-123",
    redirectUri: "https://client.example/callback",
    scope: ["environments:manage"],
    state: "client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
  };
  let completedAuthorization;
  const response = await completeGitHubUserAuthorization(
    appEnv({
      OAUTH_PROVIDER: {
        completeAuthorization: async (authorization) => {
          completedAuthorization = authorization;
          return { redirectTo: "https://client.example/callback?code=mcp-code" };
        },
      },
    }),
    {
      code: "github-code",
      callback: "https://runner.example.com/github/callback",
      codeVerifier: "verifier-123",
      payload: { authRequest },
    },
    async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "ghu_base",
          refresh_token: "ghr_refresh",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        });
      }
      if (url.endsWith("/token/scoped")) {
        return Response.json({ token: "ghu_scoped", expires_at: "2030-01-01T00:00:00Z" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 123, login: "octocat" });
      }
      return new Response("unexpected request", { status: 500 });
    },
  );

  assert.equal(response.status, 302);
  assert.equal(completedAuthorization.userId, "github-123");
  assert.deepEqual(completedAuthorization.metadata, { githubLogin: "octocat" });
  assert.equal(completedAuthorization.props.githubAccessToken, "ghu_base");
  assert.equal(completedAuthorization.props.githubRefreshToken, "ghr_refresh");
  assert.equal(completedAuthorization.props.environmentGithubAccessToken, "ghu_scoped");
  assert.equal(completedAuthorization.props.environmentGithubAccessTokenExpiresAt, 1_893_456_000);
  assert.equal(completedAuthorization.props.githubAuthorizationKind, "github_app_scoped");
  assert.deepEqual(completedAuthorization.props.oauthScopes, ["environments:manage"]);
});

test("token properties retain GitHub App refresh metadata", () => {
  assert.deepEqual(
    githubUserTokenProps(
      {
        access_token: "ghu_base",
        refresh_token: "ghr_refresh",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      },
      { token: "ghu_scoped", expires_at: "2030-01-01T00:00:00Z" },
      1_000,
    ),
    {
      githubAccessToken: "ghu_base",
      githubRefreshToken: "ghr_refresh",
      githubAccessTokenExpiresAt: 29_800,
      githubRefreshTokenExpiresAt: 15_898_600,
      environmentGithubAccessToken: "ghu_scoped",
      environmentGithubAccessTokenExpiresAt: 1_893_456_000,
      githubAuthorizationKind: "github_app_scoped",
    },
  );
});

test("MCP refresh rotates the base token and derives a new scoped token", async () => {
  const requests = [];
  const result = await githubGrantTokenExchange(
    appEnv(),
    {
      grantType: "refresh_token",
      props: {
        githubUserId: 123,
        githubLogin: "octocat",
        githubAccessToken: "ghu_old",
        githubRefreshToken: "ghr_old",
        environmentGithubAccessToken: "ghu_scoped_old",
        environmentGithubAccessTokenExpiresAt: 2_000,
        githubAuthorizationKind: "github_app_scoped",
      },
    },
    async (url, init) => {
      requests.push({ url, init });
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "ghu_new",
          refresh_token: "ghr_new",
          expires_in: 600,
          refresh_token_expires_in: 1_200,
        });
      }
      return Response.json({ token: "ghu_scoped_new", expires_at: "1970-01-01T00:25:00Z" });
    },
    () => 1_000,
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].init.body)), {
    client_id: "Iv1.example",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "ghr_old",
  });
  assert.equal(result.accessTokenTTL, 500);
  assert.equal(result.newProps.githubAccessToken, "ghu_new");
  assert.equal(result.newProps.environmentGithubAccessToken, "ghu_scoped_new");
  assert.equal(result.newProps.githubRefreshToken, "ghr_new");
});

test("old grants cannot become Environment authority", async () => {
  await assert.rejects(
    githubGrantTokenExchange(appEnv(), {
      grantType: "authorization_code",
      props: {
        githubAccessToken: "ghu_unscoped",
        githubAuthorizationKind: "github_app",
      },
    }),
    /must be reconnected/,
  );
});

test("GitHub failures expose no upstream response or credential details", async () => {
  await assert.rejects(
    exchangeGitHubUserCode(
      appEnv(),
      "invalid-code",
      "https://runner.example.com/github/callback",
      "verifier-123",
      async () => Response.json(
        { error: "bad_verification_code", secret: "upstream-detail" },
        { status: 401 },
      ),
    ),
    { message: "GitHub user token exchange failed" },
  );
  await assert.rejects(
    scopeGitHubUserToken(appEnv(), "ghu_sensitive", async () =>
      Response.json({ message: "sensitive upstream detail" }, { status: 403 })),
    { message: "GitHub user token scoping failed" },
  );
});

test("deployment reuses the GitHub App without manual installation IDs or OAuth App secrets", async () => {
  const files = await Promise.all(
    [
      "../apps/chatgpt-app/src/index.js",
      "../apps/chatgpt-app/wrangler.jsonc",
      "../docs/chatgpt-app.md",
      "../SECURITY.md",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const configuration = files.join("\n");

  assert.match(configuration, /GITHUB_APP_CLIENT_ID/);
  assert.match(configuration, /GITHUB_APP_CLIENT_SECRET/);
  assert.doesNotMatch(configuration, /GITHUB_OAUTH_CLIENT_/);
  assert.doesNotMatch(configuration, /GITHUB_APP_INSTALLATION_ID|RUNNER_INSTALLATION_ID/);
});
