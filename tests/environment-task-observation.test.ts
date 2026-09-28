import test from "node:test";
import assert from "node:assert/strict";
import { observeEnvironmentTask } from "../apps/chatgpt-app/src/environment-task-observation.ts";

test("remote snapshots check live authority before delivery and cancel the upstream on revocation", async () => {
  const taskId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
  let permitted = true;
  let cancelled = false;
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const env = { ENVIRONMENTS: { getByName(id: string) {
    assert.equal(id, `env_${"a".repeat(32)}`);
    return { async observeOperation(owner: string, task: string) {
      assert.equal(owner, "123"); assert.equal(task, taskId);
      return new ReadableStream<Uint8Array>({ start(controller) { output = controller; }, cancel() { cancelled = true; } });
    } };
  } } };
  const authorize = async () => ({ githubUserId: "123", oauthScopes: permitted ? ["environments:use"] : [] });
  const iterator = await observeEnvironmentTask(env, authorize, taskId, new AbortController().signal);
  const snapshot = { taskId, status: "working", createdAt: new Date(1).toISOString(),
    lastUpdatedAt: new Date(1).toISOString(), ttlMs: null };
  const send = () => output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(snapshot)}\n\n`));
  send();
  assert.deepEqual((await iterator.next()).value, snapshot);
  permitted = false;
  send();
  await assert.rejects(iterator.next());
  assert.equal(cancelled, true);
});

test("abort before consuming a remote observation cancels its stream", { timeout: 2000 }, async () => {
  const abort = new AbortController();
  const cancelled = Promise.withResolvers<void>();
  const env = { ENVIRONMENTS: { getByName() { return {
    async observeOperation() { return new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); } }); },
  }; } } };
  const iterator = await observeEnvironmentTask(env,
    async () => ({ githubUserId: "123", oauthScopes: ["environments:use"] }),
    `task_${"a".repeat(32)}_${"b".repeat(32)}`, abort.signal);
  abort.abort();
  assert.equal((await iterator.next()).done, true);
  await cancelled.promise;
});
