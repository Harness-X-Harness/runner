import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { GrantType } from "../apps/chatgpt-app/node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js";

// The provider runtime imports cloudflare:workers. Use its exact enum member
// values without loading that Worker-only runtime in a native Node test.
const authorizationCode = "authorization_code" as GrantType.AUTHORIZATION_CODE;
const refreshToken = "refresh_token" as GrantType.REFRESH_TOKEN;

import {
  completeGitHubUserAuthorization,
  exchangeGitHubUserCode,
  githubGrantTokenExchange,
  githubUserAuthorizationUrl,
  githubUserTokenProps,
  scopeGitHubUserToken,
} from "../apps/chatgpt-app/src/github-user-auth.ts";

type AuthorizationEnv = Parameters<typeof completeGitHubUserAuthorization>[0];
type Authorization = Parameters<typeof completeGitHubUserAuthorization>[1];
type CompletedAuthorization = Parameters<AuthorizationEnv["OAUTH_PROVIDER"]["completeAuthorization"]>[0];
const authRequest: CompletedAuthorization["request"] = {
  responseType: "code", clientId: "client-123", redirectUri: "https://client.example/callback",
  scope: ["tasks:manage"], state: "client-state", codeChallenge: "challenge", codeChallengeMethod: "S256",
};
const appEnv = (overrides: Partial<AuthorizationEnv> = {}): AuthorizationEnv => ({
  GITHUB_APP_CLIENT_ID: "Iv1.example",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
  OAUTH_PROVIDER: { completeAuthorization: async () => assert.fail("unexpected grant completion") },
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
  let captured: Request | undefined;
  const token = await exchangeGitHubUserCode(
    appEnv(),
    "callback-code",
    "https://runner.example.com/github/callback",
    "verifier-123",
    async (url, init) => {
      captured = new Request(url, init);
      return Response.json({ access_token: "ghu_access" });
    },
  );

  assert.ok(captured);
  assert.equal(captured.url, "https://github.com/login/oauth/access_token");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await captured.text())), {
    client_id: "Iv1.example",
    client_secret: "client-secret",
    code: "callback-code",
    redirect_uri: "https://runner.example.com/github/callback",
    code_verifier: "verifier-123",
  });
  assert.equal(token.access_token, "ghu_access");
});

test("Workflow token is scoped to one runner repository and Actions write", async () => {
  let captured: Request | undefined;
  const token = await scopeGitHubUserToken(appEnv(), "ghu_base", async (url, init) => {
    captured = new Request(url, init);
    return Response.json({ token: "ghu_scoped", expires_at: "2030-01-01T00:00:00Z" });
  });

  assert.ok(captured);
  assert.equal(captured.url, "https://api.github.com/applications/Iv1.example/token/scoped");
  assert.equal(captured.method, "POST");
  assert.equal(
    Buffer.from((captured.headers.get("authorization") ?? "").slice(6), "base64").toString(),
    "Iv1.example:client-secret",
  );
  assert.deepEqual(await captured.json(), {
    access_token: "ghu_base",
    target: "Harness-X-Harness",
    repositories: ["runner"],
    permissions: { actions: "write" },
  });
  assert.equal(token.token, "ghu_scoped");
});

test("GitHub callback stores only refresh and scoped workflow authority", async () => {
  let completedAuthorization: CompletedAuthorization | undefined;
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
      payload: {
        kind: "mcp",
        authRequest,
      },
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
      if (String(url).endsWith("/token/scoped")) {
        return Response.json({ token: "ghu_scoped", expires_at: "2030-01-01T00:00:00Z" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 123, login: "octocat" });
      }
      return new Response("unexpected request", { status: 500 });
    },
  );

  assert.equal(response.status, 302);
  assert.ok(completedAuthorization);
  assert.equal(completedAuthorization.userId, "github-123");
  assert.deepEqual(completedAuthorization.metadata, { githubLogin: "octocat" });
  assert.equal(completedAuthorization.props.githubAccessToken, undefined);
  assert.equal(completedAuthorization.props.githubRefreshToken, "ghr_refresh");
  assert.equal(completedAuthorization.props.environmentGithubAccessToken, "ghu_scoped");
  assert.equal(completedAuthorization.props.environmentGithubAccessTokenExpiresAt, 1_893_456_000);
  assert.equal(completedAuthorization.props.githubAuthorizationKind, "github_app_scoped");
  assert.deepEqual(completedAuthorization.props.oauthScopes, ["tasks:manage"]);
  assert.equal(completedAuthorization.props.mcpControllerGrantId, undefined);
  assert.equal(completedAuthorization.props.mcpClientName, undefined);
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
      githubRefreshToken: "ghr_refresh",
      githubRefreshTokenExpiresAt: 15_898_600,
      environmentGithubAccessToken: "ghu_scoped",
      environmentGithubAccessTokenExpiresAt: 1_893_456_000,
      githubAuthorizationKind: "github_app_scoped",
    },
  );
});

test("token exchange removes a retained legacy base access token", async () => {
  const result = await githubGrantTokenExchange(
    appEnv(),
    {
      grantType: authorizationCode,
      props: {
        githubUserId: 123,
        githubAccessToken: "ghu_legacy",
        githubAccessTokenExpiresAt: 2_000,
        githubRefreshToken: "ghr_current",
        githubRefreshTokenExpiresAt: 3_000,
        environmentGithubAccessToken: "ghu_scoped",
        environmentGithubAccessTokenExpiresAt: 2_000,
        githubAuthorizationKind: "github_app_scoped",
      },
    },
    async () => {
      throw new Error("refresh must not run");
    },
    () => 1_000,
  );

  assert.ok(result);
  assert.equal(result.accessTokenTTL, 1_000);
  assert.equal(result.newProps.githubAccessToken, undefined);
  assert.equal(result.newProps.githubAccessTokenExpiresAt, undefined);
  assert.equal(result.newProps.environmentGithubAccessToken, "ghu_scoped");
});

test("MCP refresh derives a new scoped token without retaining the base token", async () => {
  const requests: Request[] = [];
  const result = await githubGrantTokenExchange(
    appEnv(),
    {
      grantType: refreshToken,
      props: {
        githubUserId: 123,
        githubLogin: "octocat",
        githubRefreshToken: "ghr_old",
        environmentGithubAccessToken: "ghu_scoped_old",
        environmentGithubAccessTokenExpiresAt: 2_000,
        githubAuthorizationKind: "github_app_scoped",
      },
    },
    async (url, init) => {
      requests.push(new Request(url, init));
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
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await requests[0].text())), {
    client_id: "Iv1.example",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "ghr_old",
  });
  assert.ok(result);
  assert.equal(result.accessTokenTTL, 500);
  assert.equal(result.newProps.githubAccessToken, undefined);
  assert.equal(result.newProps.environmentGithubAccessToken, "ghu_scoped_new");
  assert.equal(result.newProps.githubRefreshToken, "ghr_new");
});

test("unscoped old grants cannot become workflow authority", async () => {
  await assert.rejects(
    githubGrantTokenExchange(appEnv(), {
      grantType: authorizationCode,
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

test("GitHub callback distinguishes token exchange from workflow token scoping safely", async () => {
  const authorization: Authorization = {
    code: "private-authorization-code", callback: "https://runner.example/github/callback",
    codeVerifier: "private-verifier", payload: { kind: "mcp", authRequest },
  };
  for (const [stage, upstreamStatus, reason, publicTitle] of [
    ["code_exchange", 200, "bad_verification_code", "GitHub token exchange failed"],
    ["token_scoping", 403, "upstream_rejected", "GitHub workflow token scoping failed"],
  ] as const) {
    const logs: unknown[][] = [];
    const response = await completeGitHubUserAuthorization(appEnv(), authorization, async (url) => {
      if (stage === "token_scoping" && url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "private-base-token" });
      }
      return Response.json({ error: stage === "code_exchange" ? reason : "private-upstream-error",
        error_description: "private-upstream-description", message: "private-response-body" }, { status: upstreamStatus });
    }, { error: (...args: unknown[]) => logs.push(args) });
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.equal(text, `${publicTitle} (HTTP ${upstreamStatus}; ${reason}).`);
    assert.deepEqual(logs, [["GitHub authorization failed", { stage, status: upstreamStatus, reason }]]);
    assert.doesNotMatch(JSON.stringify({ text, logs }), /private-|client-secret/);
  }
});

test("GitHub callback diagnostics omit raw HTML, network errors, and unknown OAuth values", async () => {
  const authorization: Authorization = {
    code: "private-code", callback: "https://runner.example/github/callback",
    codeVerifier: "private-verifier", payload: { kind: "mcp", authRequest },
  };
  for (const [fetchImpl, expected] of [
    [async () => new Response("<html>private-token</html>", { status: 500 }),
      { stage: "code_exchange", status: 500, reason: "invalid_response" }],
    [async () => { throw new Error("private-token in a network failure"); },
      { stage: "code_exchange", reason: "request_failed" }],
    [async () => Response.json({ error: "private-error" }, { status: 401 }),
      { stage: "code_exchange", status: 401, reason: "upstream_rejected" }],
  ] as const) {
    const logs: unknown[][] = [];
    const response = await completeGitHubUserAuthorization(appEnv(), authorization, fetchImpl,
      { error: (...args: unknown[]) => logs.push(args) });
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.deepEqual(logs, [["GitHub authorization failed", expected]]);
    assert.doesNotMatch(JSON.stringify({ text, logs }), /private-|client-secret|<html>/);
  }
});

test("deployment uses only GitHub App user authorization and no installation-token credentials", async () => {
  const files = await Promise.all(
    [
      "../apps/chatgpt-app/src/index.ts",
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
  assert.doesNotMatch(
    configuration,
    /secret put GITHUB_APP_PRIVATE_KEY|RUNNER_GITHUB_APP_ID|RUNNER_GITHUB_APP_PRIVATE_KEY/,
  );
});
