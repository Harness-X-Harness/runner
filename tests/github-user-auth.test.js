import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeGitHubUserAuthorization,
  exchangeGitHubUserCode,
  githubGrantTokenExchange,
  githubUserAuthorizationUrl,
  refreshGitHubUserToken,
} from "../apps/chatgpt-app/src/github-user-auth.js";

test("GitHub App user authorization uses its client id without OAuth scopes", () => {
  const url = githubUserAuthorizationUrl(
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
    },
    "https://runner.example.com/github/callback",
    "state-123",
  );

  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv1.example");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://runner.example.com/github/callback",
  );
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.has("scope"), false);
});

test("GitHub App callback exchanges its code with the app client credentials", async () => {
  let captured;
  const token = await exchangeGitHubUserCode(
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    },
    "callback-code",
    "https://runner.example.com/github/callback",
    async (url, init) => {
      captured = { url, init };
      return Response.json({
        access_token: "ghu_access",
        expires_in: 28800,
        refresh_token: "ghr_refresh",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      });
    },
  );

  assert.equal(captured.url, "https://github.com/login/oauth/access_token");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.accept, "application/json");
  assert.equal(
    captured.init.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(captured.init.body)),
    {
      client_id: "Iv1.example",
      client_secret: "client-secret",
      code: "callback-code",
      redirect_uri: "https://runner.example.com/github/callback",
    },
  );
  assert.equal(token.access_token, "ghu_access");
  assert.equal(token.refresh_token, "ghr_refresh");
});

test("GitHub callback completes OAuth with a delimiter-safe user id", async () => {
  const authRequest = {
    responseType: "code",
    clientId: "client-123",
    redirectUri: "https://client.example/callback",
    scope: ["tasks:read"],
    state: "client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
  };
  let completedAuthorization;
  let profileRequest;
  const response = await completeGitHubUserAuthorization(
    new Request(
      "https://runner.example.com/github/callback?state=github-state&code=github-code",
    ),
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      OAUTH_KV: {
        get: async () => JSON.stringify(authRequest),
        delete: async () => {},
      },
      OAUTH_PROVIDER: {
        completeAuthorization: async (authorization) => {
          completedAuthorization = authorization;
          return {
            redirectTo:
              "https://client.example/callback?code=github-123%3Agrant%3Asecret",
          };
        },
      },
    },
    async (url, init) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "ghu_access" });
      }
      if (url === "https://api.github.com/user") {
        profileRequest = init;
        return Response.json({ id: 123, login: "octocat" });
      }
      return new Response("unexpected request", { status: 500 });
    },
  );

  assert.equal(response.status, 302);
  assert.equal(completedAuthorization.userId, "github-123");
  assert.deepEqual(completedAuthorization.metadata, {
    githubLogin: "octocat",
  });
  assert.equal(completedAuthorization.props.githubUserId, 123);
  assert.equal(completedAuthorization.props.githubLogin, "octocat");
  assert.equal(profileRequest.headers["user-agent"], "WeaverTaskRunner");
});

test("GitHub callback rejects a non-JSON profile error before creating a grant", async () => {
  let completedAuthorization = false;
  const response = await completeGitHubUserAuthorization(
    new Request(
      "https://runner.example.com/github/callback?state=github-state&code=github-code",
    ),
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      OAUTH_KV: {
        get: async () =>
          JSON.stringify({
            responseType: "code",
            clientId: "client-123",
            redirectUri: "https://client.example/callback",
            scope: ["tasks:read"],
          }),
        delete: async () => {},
      },
      OAUTH_PROVIDER: {
        completeAuthorization: async () => {
          completedAuthorization = true;
          return { redirectTo: "https://client.example/callback" };
        },
      },
    },
    async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "ghu_access" });
      }
      return new Response("User-Agent header required", {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  );

  assert.equal(response.status, 502);
  assert.equal(await response.text(), "GitHub profile lookup failed");
  assert.equal(completedAuthorization, false);
});

test("GitHub callback reports grant completion failures without exposing credentials", async () => {
  const logEntries = [];
  const response = await completeGitHubUserAuthorization(
    new Request(
      "https://runner.example.com/github/callback?state=github-state&code=github-code",
    ),
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      OAUTH_KV: {
        get: async () =>
          JSON.stringify({
            responseType: "code",
            clientId: "client-123",
            redirectUri: "https://client.example/callback",
            scope: ["tasks:read"],
          }),
        delete: async () => {},
      },
      OAUTH_PROVIDER: {
        completeAuthorization: async () => {
          throw new Error("KV grant write failed");
        },
      },
    },
    async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "ghu_sensitive_access",
          refresh_token: "ghr_sensitive_refresh",
        });
      }
      return Response.json({ id: 123, login: "octocat" });
    },
    {
      error(...values) {
        logEntries.push(values);
      },
    },
  );

  assert.equal(response.status, 502);
  assert.equal(await response.text(), "OAuth grant creation failed");
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0][0], "GitHub OAuth grant completion failed");
  const serializedLog = JSON.stringify(logEntries);
  assert.doesNotMatch(
    serializedLog,
    /github-state|github-code|ghu_sensitive_access|ghr_sensitive_refresh/,
  );
});

test("refreshing the MCP grant rotates the GitHub App user token", async () => {
  let parameters;
  const token = await refreshGitHubUserToken(
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    },
    "ghr_old",
    async (_url, init) => {
      parameters = Object.fromEntries(new URLSearchParams(init.body));
      return Response.json({
        access_token: "ghu_new",
        expires_in: 28800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      });
    },
  );

  assert.deepEqual(parameters, {
    client_id: "Iv1.example",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "ghr_old",
  });
  assert.equal(token.access_token, "ghu_new");
  assert.equal(token.refresh_token, "ghr_new");
});

test("MCP token refresh rotates the encrypted GitHub App user credentials", async () => {
  const result = await githubGrantTokenExchange(
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    },
    {
      grantType: "refresh_token",
      props: {
        githubUserId: 123,
        githubLogin: "octocat",
        githubAccessToken: "ghu_old",
        githubRefreshToken: "ghr_old",
        githubAccessTokenExpiresAt: 28800,
        githubRefreshTokenExpiresAt: 15897600,
        oauthScopes: ["tasks:read"],
      },
    },
    async () =>
      Response.json({
        access_token: "ghu_new",
        expires_in: 28800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      }),
    () => 100,
  );

  assert.deepEqual(result, {
    newProps: {
      githubUserId: 123,
      githubLogin: "octocat",
      githubAccessToken: "ghu_new",
      githubRefreshToken: "ghr_new",
      githubAccessTokenExpiresAt: 28900,
      githubRefreshTokenExpiresAt: 15897700,
      oauthScopes: ["tasks:read"],
    },
    accessTokenTTL: 28800,
  });
});

test("initial MCP token lifetime follows the GitHub App user token", async () => {
  const result = await githubGrantTokenExchange(
    {},
    {
      grantType: "authorization_code",
      props: {
        githubAccessToken: "ghu_access",
        githubRefreshToken: "ghr_refresh",
        githubAccessTokenExpiresAt: 1000,
        githubRefreshTokenExpiresAt: 2000,
      },
    },
    undefined,
    () => 900,
  );

  assert.deepEqual(result, {
    accessTokenTTL: 100,
    refreshTokenTTL: 1100,
  });
});

test("an expired GitHub user token is refreshed before issuing an MCP token", async () => {
  const result = await githubGrantTokenExchange(
    {
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    },
    {
      grantType: "authorization_code",
      props: {
        githubAccessToken: "ghu_expired",
        githubRefreshToken: "ghr_refresh",
        githubAccessTokenExpiresAt: 100,
        githubRefreshTokenExpiresAt: 10000,
      },
    },
    async () =>
      Response.json({
        access_token: "ghu_fresh",
        expires_in: 28800,
        refresh_token: "ghr_fresh",
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
        scope: "",
      }),
    () => 200,
  );

  assert.equal(result.newProps.githubAccessToken, "ghu_fresh");
  assert.equal(result.newProps.githubRefreshToken, "ghr_fresh");
  assert.equal(result.accessTokenTTL, 28800);
  assert.equal(result.refreshTokenTTL, 15897600);
});

test("GitHub token failures expose no upstream response details", async () => {
  await assert.rejects(
    exchangeGitHubUserCode(
      {
        GITHUB_APP_CLIENT_ID: "Iv1.example",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
      },
      "invalid-code",
      "https://runner.example.com/github/callback",
      async () =>
        Response.json(
          {
            error: "bad_verification_code",
            error_description: "internal upstream details",
          },
          { status: 401 },
        ),
    ),
    {
      message: "GitHub user token exchange failed",
    },
  );
});

test("deployment configuration requires only one GitHub application", async () => {
  const files = await Promise.all(
    [
      "../apps/chatgpt-app/src/index.js",
      "../apps/chatgpt-app/wrangler.jsonc",
      "../docs/chatgpt-app.md",
      "../SECURITY.md",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const configuration = files.join("\n");

  assert.doesNotMatch(configuration, /GITHUB_OAUTH_/);
  assert.doesNotMatch(
    configuration,
    /GITHUB_APP_INSTALLATION_ID|RUNNER_INSTALLATION_ID/,
  );
  assert.match(configuration, /GITHUB_APP_CLIENT_ID/);
  assert.match(configuration, /GITHUB_APP_CLIENT_SECRET/);
});
