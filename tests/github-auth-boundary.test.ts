import assert from "node:assert/strict";
import test from "node:test";
import {
  completeGitHubUserAuthorization, exchangeGitHubUserCode, requestGitHubUserProfile,
} from "../apps/chatgpt-app/src/github-user-auth.ts";

const credentials = {
  GITHUB_APP_CLIENT_ID: "fixture-client", GITHUB_APP_CLIENT_SECRET: "PRIVATE_CLIENT_SECRET",
  GITHUB_RUNNER_REPOSITORY: "fixture/runner",
};

test("GitHub JSON fields are validated before use as credentials or identity", async () => {
  for (const body of [{ access_token: 42 }, { access_token: "" }, { access_token: "PRIVATE_TOKEN", refresh_token: {} }]) {
    await assert.rejects(exchangeGitHubUserCode(credentials, "code", "https://control.example/github/callback", "verifier",
      async () => Response.json(body)), { message: "GitHub user token exchange failed" });
  }
  for (const body of [{ id: "123", login: "fixture" }, { id: 123, login: {} }, null]) {
    await assert.rejects(requestGitHubUserProfile("PRIVATE_TOKEN", async () => Response.json(body)),
      { message: "GitHub user profile lookup failed" });
  }
});

test("OAuth grant completion failures do not print upstream diagnostics", async () => {
  const logs: unknown[][] = [];
  const env = { ...credentials, OAUTH_PROVIDER: {
    async completeAuthorization(): Promise<{ redirectTo: string }> {
      throw new Error("PRIVATE_GRANT_TOKEN");
    },
  } };
  const authorization: Parameters<typeof completeGitHubUserAuthorization>[1] = {
    callback: "https://control.example/github/callback", code: "code", codeVerifier: "verifier",
    payload: { kind: "mcp", authRequest: {
      responseType: "code", clientId: "client", redirectUri: "https://client.example/callback",
      scope: ["tasks:manage"], state: "state", codeChallenge: "challenge", codeChallengeMethod: "S256",
    } },
  };
  const response = await completeGitHubUserAuthorization(env, authorization, async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/access_token")) return Response.json({ access_token: "PRIVATE_BASE_TOKEN" });
    if (url.pathname.endsWith("/scoped")) return Response.json({ token: "PRIVATE_SCOPED_TOKEN" });
    if (url.pathname === "/user") return Response.json({ id: 123, login: "fixture" });
    throw new Error("Unexpected request");
  }, { error: (...args: unknown[]) => { logs.push(args); } });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "OAuth grant creation failed");
  assert.deepEqual(logs, [["GitHub OAuth grant completion failed", { reason: "grant_completion_failed" }]]);
});
