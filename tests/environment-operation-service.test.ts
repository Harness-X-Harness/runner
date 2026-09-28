import test from "node:test";
import assert from "node:assert/strict";
import { startEnvironmentOperation, readEnvironmentOperation } from "../apps/chatgpt-app/src/environment-operation-service.ts";

test("operation identity routes without an index and preserves owner and input boundaries", async () => {
  const environmentId = `env_${"a".repeat(32)}`;
  const props = { githubUserId: "123", oauthScopes: ["environments:use"] };
  const records = new Map<string, { request: string; runtimeId: string; createdAt: number; updatedAt: number }>();
  let lookups = 0;
  const env = { ENVIRONMENTS: { getByName(id: string) {
    lookups++;
    assert.equal(id, environmentId);
    return {
      async reserveOperation(owner: string, taskId: string, request: string) {
        assert.equal(owner, "123");
        const old = records.get(taskId);
        if (old && old.request !== request) throw new Error("OPERATION_ID_CONFLICT");
        const record = old ?? { request, runtimeId: "private-runtime", createdAt: 1, updatedAt: 1 };
        records.set(taskId, record); return record;
      },
      async readOperation(owner: string, taskId: string) {
        return owner === "123" ? records.get(taskId) ?? null : null;
      },
    };
  } } };
  const request = { kind: "command", environmentId, argv: ["pwd"], timeoutSeconds: 10, idempotencyKey: "one" };
  await assert.rejects(startEnvironmentOperation(env, { ...props, oauthScopes: ["tasks:manage"] }, request));
  await assert.rejects(startEnvironmentOperation(env, props, { ...request, argv: [] }));
  await assert.rejects(startEnvironmentOperation(env, props, { ...request, timeoutSeconds: -1 }));
  assert.equal(lookups, 0);
  const first = await startEnvironmentOperation(env, props, request);
  assert.deepEqual(await startEnvironmentOperation(env, props, { ...request, cwd: "." }), first);
  assert.equal(records.size, 1);
  assert.deepEqual(JSON.parse((await readEnvironmentOperation(env, props, first.taskId)).request),
    { kind: "command", argv: ["pwd"], cwd: ".", timeoutSeconds: 10 });
  await assert.rejects(startEnvironmentOperation(env, props, { ...request, argv: ["ls"] }), /OPERATION_ID_CONFLICT/);
  await assert.rejects(startEnvironmentOperation(env, props,
    { kind: "agent", environmentId, prompt: "hello", idempotencyKey: "one" }), /OPERATION_ID_CONFLICT/);
  await assert.rejects(readEnvironmentOperation(env, { ...props, githubUserId: "456" }, first.taskId), /not found or is no longer available/);
  assert.deepEqual(Object.keys(first), ["taskId"]);
  const count = lookups;
  await assert.rejects(readEnvironmentOperation(env, props, "task_invalid"));
  assert.equal(lookups, count);
});
