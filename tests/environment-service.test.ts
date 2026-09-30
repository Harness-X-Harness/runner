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
        records.set(name, record); return { ...record, admitted: true as const };
      },
      async dispatchExecution(owner: string, token: string) {
        assert.equal(records.get(name)?.ownerId, owner);
        assert.equal(token, "PRIVATE_TOKEN");
        if (dispatched.has(name)) return "already-issued" as const;
        dispatched.add(name); return "accepted" as const;
      },
      async requestClose() { return "closing" as const; },
      async closeExecution() { return "closing" as const; },
      async readEnvironment() { return null; },
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
    async readEnvironment() { return null; },
  }; } } };
  await assert.rejects(closeEnvironment(env, { ...props, environmentGithubAccessTokenExpiresAt: 1 },
    { environmentId: `env_${"a".repeat(32)}` }));
  assert.equal(intent, true);
});

test("owner capacity returns only owner-authorized identity and status without dispatch or close", async () => {
  const environmentId = `env_${"a".repeat(32)}`;
  let readMode: "visible" | "missing" | "fault" = "visible";
  const env = { ENVIRONMENTS: { getByName(id: string) { return {
    async initialize() { return { admitted: false as const, capacityKind: "owner" as const,
      retryable: false as const, existingEnvironmentId: environmentId }; },
    async readEnvironment(owner: string) {
      assert.equal(owner, "123"); assert.equal(id, environmentId);
      if (readMode === "fault") throw new Error("PRIVATE_STORAGE_FAILURE");
      if (readMode === "missing") return null;
      return { environmentId, status: "closing" as const, executor: "codex" as const,
        createdAt: 1, expiresAt: null, activeTaskId: null };
    },
    async dispatchExecution(): Promise<never> { throw new Error("must not dispatch"); },
    async requestClose(): Promise<never> { throw new Error("must not close"); },
    async closeExecution(): Promise<never> { throw new Error("must not reconcile"); },
  }; } } };
  assert.deepEqual(await openEnvironment(env, props, { executor: "codex" }), {
    admitted: false, capacityKind: "owner", retryable: false,
    existingEnvironment: { environmentId, status: "closing" },
  });
  readMode = "missing";
  assert.deepEqual(await openEnvironment(env, props, { executor: "codex" }), {
    admitted: false, capacityKind: "owner", retryable: false, existingEnvironment: { environmentId },
  });
  readMode = "fault";
  await assert.rejects(openEnvironment(env, props, { executor: "codex" }), /PRIVATE_STORAGE_FAILURE/);
});
