import assert from "node:assert/strict";
import test from "node:test";
import { startT3Access } from "../apps/chatgpt-app/src/t3-access.ts";
import { completeAuthorizationCallback } from "../apps/chatgpt-app/src/authorization.ts";
import { fakeAuthorizationStates } from "./helpers/authorization-state.ts";
import type { AuthorizationEnvironment } from "../apps/chatgpt-app/src/authorization.ts";

const environmentId = "env_" + "b".repeat(32);
const privatePairUrl = "https://quiet-leaf.trycloudflare.com/pair#token=PRIVATE_PAIR_SECRET";

function fixture(owner = "123") {
  const states = fakeAuthorizationStates();
  const calls: string[] = [];
  const env: AuthorizationEnvironment = {
    AUTHORIZATION_STATES: states.binding,
    GITHUB_APP_CLIENT_ID: "Iv1.fixture", GITHUB_APP_CLIENT_SECRET: "PRIVATE_CLIENT_SECRET",
    GITHUB_RUNNER_REPOSITORY: "fixture/runner",
    ENVIRONMENTS: {
      getByName: (id: string) => ({
        issueT3Pairing: async (requestedOwner: string) => {
          calls.push(id + ":" + requestedOwner);
          if (id !== environmentId || requestedOwner !== owner) throw new Error("NOT_OWNER");
          return privatePairUrl;
        },
      }),
    } as unknown as AuthorizationEnvironment["ENVIRONMENTS"],
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => assert.fail("T3 flow must not change MCP grants"),
      lookupClient: async () => assert.fail("T3 flow must not change MCP grants"),
      completeAuthorization: async () => assert.fail("T3 flow must not create MCP grants"),
    },
  };
  const fetchImpl: typeof fetch = async input => {
    if (String(input).includes("/login/oauth/access_token")) {
      return Response.json({ access_token: "PRIVATE_GITHUB_TOKEN" });
    }
    if (String(input) === "https://api.github.com/user") {
      return Response.json({ id: 123, login: "fixture-owner" });
    }
    throw new Error("Unexpected network");
  };
  return { states, env, calls, fetchImpl };
}

test("T3 entry requires a precise Environment id and initiates bound PKCE GitHub login", async () => {
  const { states, env } = fixture();
  for (const bad of ["/t3/connect/unknown", "/t3/connect/" + environmentId + "?next=https://attacker.example"]) {
    assert.equal((await startT3Access(new Request("https://runner.example" + bad), env)).status, 404);
  }
  const response = await startT3Access(new Request("https://runner.example/t3/connect/" + environmentId), env);
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get("location")!);
  assert.equal(redirect.host, "github.com");
  assert.equal(redirect.pathname, "/login/oauth/authorize");
  assert.equal(redirect.searchParams.get("redirect_uri"), "https://runner.example/github/callback");
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; Secure/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(states.size(), 1);
  const state = states.values()[0];
  assert.ok(state && "payload" in state && state.payload.kind === "t3");
  assert.equal(state.payload.environmentId, environmentId);
  assert.equal(JSON.stringify(state).includes("PRIVATE_PAIR_SECRET"), false);
});

test("only the GitHub owner receives a short-lived native Pairing redirect, once", async () => {
  const { env, states, calls, fetchImpl } = fixture();
  const opened = await startT3Access(new Request("https://runner.example/t3/connect/" + environmentId), env);
  const authUrl = new URL(opened.headers.get("location")!);
  const oauthCookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const callback = "https://runner.example/github/callback?state=" +
    encodeURIComponent(authUrl.searchParams.get("state")!) + "&code=fixture";
  const request = () => new Request(callback, { headers: { cookie: oauthCookie } });
  const response = await completeAuthorizationCallback(request(), env, fetchImpl);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), privatePairUrl);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.deepEqual(calls, [environmentId + ":123"]);
  assert.equal(states.size(), 0, "OAuth state must be single use");
  const replay = await completeAuthorizationCallback(request(), env, fetchImpl);
  assert.equal(replay.status, 400);
  assert.deepEqual(calls, [environmentId + ":123"]);
  assert.ok(!(await replay.text()).includes("PRIVATE_PAIR_SECRET"));
});

test("wrong owner, missing browser binding and token exchange failure never issue credentials", async () => {
  for (const mode of ["wrong-owner", "missing-cookie", "token-error"] as const) {
    const { env, calls, fetchImpl } = fixture(mode === "wrong-owner" ? "999" : "123");
    const opened = await startT3Access(new Request("https://runner.example/t3/connect/" + environmentId), env);
    const authorization = new URL(opened.headers.get("location")!);
    const callback = "https://runner.example/github/callback?state=" +
      encodeURIComponent(authorization.searchParams.get("state")!) + "&code=fixture";
    const cookie = mode === "missing-cookie" ? "" : opened.headers.get("set-cookie")!.split(";")[0]!;
    const response = await completeAuthorizationCallback(new Request(callback, { headers: { cookie } }), env,
      mode === "token-error" ? async () => new Response("Forbidden", { status: 403 }) : fetchImpl);
    assert.notEqual(response.status, 302);
    assert.equal(response.headers.has("location"), false);
    assert.ok(!(await response.text()).includes("PRIVATE_PAIR_SECRET"));
    assert.deepEqual(calls, mode === "wrong-owner" ? [environmentId + ":123"] : []);
  }
});
