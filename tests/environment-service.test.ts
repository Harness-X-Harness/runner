import test from "node:test";
import assert from "node:assert/strict";
import { openEnvironment, closeEnvironment, ENVIRONMENT_SCOPE } from "../apps/chatgpt-app/src/environment-service.ts";

const props = { githubUserId: "123", oauthScopes: [ENVIRONMENT_SCOPE],
  githubAuthorizationKind: "github_app_scoped", environmentGithubAccessToken: "PRIVATE_TOKEN" };

test("new Environment scope gates admission; deterministic identity is owner scoped", async () => {
  const records = new Map<string, { environmentId: string; ownerId: string; executor: "codex" | "grok"; createdAt: number; admitUntil: number }>();
  const dispatched = new Set<string>();
  let lookups = 0;
  const env = { ENVIRONMENTS: { getByName(name: string) {
    lookups++;
    return {
      async initialize(input: { environmentId: string; ownerId: string; executor: "codex" | "grok" }) {
        const existing = records.get(name);
        if (existing && existing.executor !== input.executor) throw new Error("ENVIRONMENT_CREATION_CONFLICT");
        const record = existing ?? { ...input, createdAt: 1, admitUntil: 100 };
        records.set(name, record); return record;
      },
      async dispatchExecution(owner: string, token: string) {
        assert.equal(records.get(name)?.ownerId, owner);
        assert.equal(token, "PRIVATE_TOKEN");
        if (dispatched.has(name)) return "already-issued" as const;
        dispatched.add(name); return "accepted" as const;
      },
      async requestClose() { return "closing" as const; },
      async closeExecution() { return "closing" as const; },
    };
  } } };
  for (const oauthScopes of [[], ["tasks:manage"], ["environments:manage"]]) {
    await assert.rejects(openEnvironment(env, { ...props, oauthScopes }, { executor: "codex" }));
  }
  await assert.rejects(openEnvironment(env, { ...props, environmentGithubAccessTokenExpiresAt: 1 }, { executor: "codex" }));
  assert.equal(lookups, 0);
  const request = { executor: "codex", idempotencyKey: "same-key" };
  const first = await openEnvironment(env, props, request);
  const repeat = await openEnvironment(env, props, request);
  assert.equal(first.environmentId, repeat.environmentId);
  assert.equal(repeat.dispatch, "already-issued");
  assert.equal(dispatched.size, 1);
  assert.notEqual((await openEnvironment(env, { ...props, githubUserId: "456" }, request)).environmentId, first.environmentId);
  await assert.rejects(openEnvironment(env, props, { ...request, executor: "grok" }), { message: "ENVIRONMENT_CREATION_CONFLICT" });
  assert.notEqual((await openEnvironment(env, props, { executor: "codex" })).environmentId,
    (await openEnvironment(env, props, { executor: "codex" })).environmentId);
  assert.ok(!JSON.stringify(first).includes("PRIVATE_TOKEN"));
});

test("close preserves intent before expired external authority is rejected", async () => {
  let intent = false;
  const env = { ENVIRONMENTS: { getByName() { return {
    async initialize(): Promise<never> { throw new Error(); },
    async dispatchExecution(): Promise<never> { throw new Error(); },
    async requestClose(owner: string) { assert.equal(owner, "123"); intent = true; return "closing" as const; },
    async closeExecution(): Promise<never> { throw new Error("must not call GitHub"); },
  }; } } };
  await assert.rejects(closeEnvironment(env, { ...props, environmentGithubAccessTokenExpiresAt: 1 },
    { environmentId: `env_${"a".repeat(32)}` }));
  assert.equal(intent, true);
});
