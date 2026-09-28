import assert from "node:assert/strict";
import test from "node:test";
import { runnerIdentity } from "../.github/actions/runner-identity.ts";
import { claimRunnerEnvironment, connectRunnerEnvironment } from "../.github/actions/agent-runtime/environment-identity.ts";

const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?request=one",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "PRIVATE_JOB_ASSERTION" };

test("Environment claim uses header-only job authority and returns only trusted bootstrap fields", async () => {
  const environmentId = `env_${"a".repeat(32)}`;
  const expected = { decision: "bound", executor: "codex", deadline: Date.now() + 60000 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oidc.example") return Response.json({ value: "OIDC_ASSERTION" });
    assert.equal(url.href, `https://control.example/internal/environments/${environmentId}/claim`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("x-harness-github-token"), "PRIVATE_GITHUB_TOKEN");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer OIDC_ASSERTION");
    return Response.json(expected);
  };
  const claim = () => claimRunnerEnvironment("https://control.example", environmentId,
    new AbortController().signal, { ...env, GITHUB_TOKEN: "PRIVATE_GITHUB_TOKEN" }, fetchImpl);
  assert.deepEqual(await claim(), expected);
  expected.deadline = Date.now() - 1;
  assert.deepEqual(await claim(), { decision: "stop" });
});

test("each runner connection assertion is fresh, audience-bound and header-only", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://oidc.example");
    assert.equal(url.searchParams.get("request"), "one");
    assert.equal(url.searchParams.get("audience"), "https://control.example");
    assert.ok(!url.href.includes(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`);
    assert.equal(init?.redirect, "error");
    return Response.json({ value: `assertion-${++calls}` });
  };
  assert.equal(await runnerIdentity("https://control.example", env, fetchImpl), "assertion-1");
  assert.equal(await runnerIdentity("https://control.example", env, fetchImpl), "assertion-2");
});

test("OIDC failures are sanitized and invalid destinations never request credentials", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("PRIVATE_UPSTREAM_DIAGNOSTIC"); },
    async () => new Response("PRIVATE_UPSTREAM_DIAGNOSTIC", { status: 503 }),
    async () => Response.json({ value: "" }),
  ]) {
    await assert.rejects(runnerIdentity("https://control.example", env, fetchImpl),
      { message: "RUNNER_IDENTITY_UNAVAILABLE" });
  }
  let called = false;
  const noFetch: typeof fetch = async () => { called = true; throw new Error(); };
  for (const origin of ["http://control.example", "https://control.example/path", "https://user@control.example"]) {
    await assert.rejects(runnerIdentity(origin, env, noFetch), { message: "RUNNER_IDENTITY_UNAVAILABLE" });
    await assert.rejects(connectRunnerEnvironment(origin, `env_${"a".repeat(32)}`,
      "00000000-0000-4000-8000-000000000001", new AbortController().signal, env, noFetch));
  }
  await assert.rejects(connectRunnerEnvironment("https://control.example", "invalid", "invalid",
    new AbortController().signal, env, noFetch));
  assert.equal(called, false);
});
