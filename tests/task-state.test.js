import assert from "node:assert/strict";
import test from "node:test";
import { TaskStore, validateTaskInput } from "../apps/chatgpt-app/src/task-state.js";
import { TASK_LIMITS, isTaskId, newTaskId } from "../shared/task-contract.js";
import { TaskError } from "../shared/task-errors.js";
import { taskStorage } from "./helpers/task-storage.js";

const ownerId = "123";
const execution = { ownerId, runId: "100", runAttempt: "1" };
const foreignRun = { ...execution, runId: "101" };
const newAttempt = { ...execution, runAttempt: "2" };
const otherOwner = { ...execution, ownerId: "456" };
const final = (text = "Final answer") => ({ status: "completed", result: { finalResponse: text } });
const failed = { status: "failed", error: { code: "PROVIDER_EXECUTION_ERROR", message: "PRIVATE_ERROR" } };
const code = (value) => ({ code: value });

async function setup() {
  let now = Date.parse("2026-09-12T00:00:00Z");
  const storage = taskStorage();
  const store = new TaskStore(storage, { now: () => now });
  const input = { taskId: newTaskId(), ownerId, executor: "codex",
    prompt: "PRIVATE_PROMPT", repository: "example/runner" };
  const task = await store.create(input);
  return { store, storage, input, task, advance: (ms) => { now += ms; } };
}

test("Task identity contains 128 random bits; input is bounded at UTF-8 bytes", async () => {
  const ids = new Set(Array.from({ length: 100 }, newTaskId));
  assert.equal(ids.size, 100);
  assert.ok([...ids].every(isTaskId));
  assert.equal(isTaskId("task_known-id"), false);
  const prompt = "a".repeat(TASK_LIMITS.promptBytes);
  assert.doesNotThrow(() => validateTaskInput({ executor: "codex", prompt }));
  for (const input of [{ executor: "other", prompt: "ok" }, { executor: "grok", prompt: " " },
    { executor: "grok", prompt: prompt + "x" }, { executor: "codex", prompt: "文".repeat(TASK_LIMITS.promptBytes) }]) {
    assert.throws(() => validateTaskInput(input), code("INVALID_TASK_INPUT"));
  }
});

test("Task reads and all user mutations enforce owner without private serialization", async () => {
  const { store, storage, task } = await setup();
  for (const action of [() => store.read("456"), () => store.wait("456", 0),
    () => store.control("456"), () => store.cancel("456"), () => store.dispatchFailed("456"),
    () => store.executionEnded("456", execution, "cancelled")]) {
    await assert.rejects(action, code("TASK_NOT_FOUND"));
  }
  assert.deepEqual(Object.keys(task).sort(), ["createdAt", "executor", "status", "taskId", "updatedAt"]);
  await assert.rejects(store.claim(otherOwner), code("CLAIM_REJECTED"));
  await store.claim(execution);
  await store.finish(execution, failed);
  const snapshot = JSON.stringify(await store.read(ownerId));
  for (const marker of ["PRIVATE_PROMPT", "PRIVATE_ERROR", "ownerId", "runAttempt", "finishDigest", "prompt", "execution"]) {
    assert.equal(snapshot.includes(marker), false, marker);
  }
  assert.equal((await storage.get("task")).prompt, undefined);
});

test("exact-run claim is idempotent; concurrent run and attempt cannot acquire prompt", async () => {
  const { store, storage } = await setup();
  const results = await Promise.allSettled([store.claim(execution), store.claim(foreignRun), store.claim(newAttempt)]);
  assert.deepEqual(results.map((x) => x.status), ["fulfilled", "rejected", "rejected"]);
  const first = results[0].value;
  assert.deepEqual(await store.claim(execution), first);
  assert.equal(first.prompt, "PRIVATE_PROMPT");
  assert.deepEqual(Object.keys(first).sort(), ["executor", "prompt", "taskId"]);
  assert.deepEqual((await storage.get("task")).execution, execution);
});

test("committed pre-claim cancellation rejects every later claim and finish", async () => {
  const { store, storage } = await setup();
  const [cancel, claim] = await Promise.allSettled([store.cancel(ownerId), store.claim(execution)]);
  assert.equal(cancel.value.task.status, "cancelling");
  assert.equal(claim.reason.code, "CLAIM_REJECTED");
  for (const e of [execution, foreignRun, newAttempt]) {
    await assert.rejects(store.claim(e), code("CLAIM_REJECTED"));
    await assert.rejects(store.finish(e, final()), code("CLAIM_REJECTED"));
  }
  assert.equal((await store.dispatchFailed(ownerId)).status, "cancelled");
  assert.equal((await storage.get("task")).prompt, undefined);
});

test("completion and cancellation use first terminal commit, not cancellation intent", async () => {
  for (const finishFirst of [true, false]) {
    const { store, storage } = await setup();
    await assert.rejects(store.finish(execution, final()), code("CLAIM_REJECTED"));
    await store.claim(execution);
    await store.cancel(ownerId);
    await assert.rejects(store.claim(execution), code("CLAIM_REJECTED"));
    const complete = () => store.finish(execution, final());
    const cancel = () => store.executionEnded(ownerId, execution, "cancelled");
    await (finishFirst ? complete() : cancel());
    const terminal = await store.read(ownerId);
    if (finishFirst) assert.deepEqual(await cancel(), terminal);
    else await assert.rejects(complete(), code("CLAIM_REJECTED"));
    assert.equal(terminal.status, finishFirst ? "completed" : "cancelled");
    assert.deepEqual((await store.cancel(ownerId)).task, terminal);
    assert.deepEqual(await store.dispatchFailed(ownerId), terminal);
    assert.equal((await storage.get("task")).prompt, undefined);
  }
});

test("finish replay preserves exact outcome and original retention, rejects foreign and conflicting results", async () => {
  const { store, storage, advance } = await setup();
  await store.claim(execution);
  const answer = await store.finish(execution, final());
  const alarm = await storage.getAlarm();
  advance(1000);
  assert.deepEqual(await store.finish(execution, final()), answer);
  assert.equal(await storage.getAlarm(), alarm);
  for (const input of [final("different"), failed]) await assert.rejects(store.finish(execution, input), code("CLAIM_REJECTED"));
  for (const e of [foreignRun, newAttempt, otherOwner]) await assert.rejects(store.finish(e, final()), code("CLAIM_REJECTED"));
  await assert.rejects(store.claim(execution), code("CLAIM_REJECTED"));
});

test("empty final text is rejected; oversized final truncates only at a complete Unicode character", async () => {
  const { store } = await setup();
  await store.claim(execution);
  for (const input of [final(""), final(" \n"), { status: "running" }, { status: "failed", error: { code: "RAW_SECRET" } }]) {
    await assert.rejects(store.finish(execution, input), code("INVALID_TASK_INPUT"));
  }
  const prefix = "a".repeat(TASK_LIMITS.resultBytes - 1);
  const answer = await store.finish(execution, final(prefix + "🙂tail"));
  assert.deepEqual(answer.result, { finalResponse: prefix, truncated: true });
  await assert.rejects(store.finish(execution, final(prefix + "🙂different")), code("CLAIM_REJECTED"));
  assert.deepEqual(await store.finish(execution, final(prefix + "🙂tail")), answer);
});

test("safe canonical errors and terminal deletion cover dispatch, provider, timeout and lost finish", async () => {
  for (const end of ["dispatch", "provider", "timed_out", "success", "cancelled"]) {
    const { store, storage } = await setup();
    let result;
    if (end === "dispatch") result = await store.dispatchFailed(ownerId);
    else {
      await store.claim(execution);
      result = end === "provider" ? await store.finish(execution, failed)
        : await store.executionEnded(ownerId, execution, end);
    }
    const expected = { dispatch: "DISPATCH_FAILED", provider: "PROVIDER_EXECUTION_ERROR",
      timed_out: "TASK_TIMEOUT", success: "EXECUTION_ENDED", cancelled: "CANCELLED" }[end];
    assert.deepEqual(result.error, new TaskError(expected).toJSON());
    assert.ok(Buffer.byteLength(JSON.stringify(result.error)) <= TASK_LIMITS.errorBytes);
    assert.equal((await storage.get("task")).prompt, undefined);
  }
});

test("bounded wait returns on changes or timeout and removes subscriptions", async () => {
  const { store } = await setup();
  assert.equal((await store.wait(ownerId, 0)).status, "queued");
  for (const timeout of [-1, Infinity, 26]) await assert.rejects(store.wait(ownerId, timeout), code("INVALID_TASK_INPUT"));
  const waiting = store.wait(ownerId, 1);
  await store.claim(execution);
  assert.equal((await waiting).status, "running");
  let returned = false;
  const unchanged = store.wait(ownerId, 0.015).then((x) => { returned = true; return x; });
  await store.claim(execution);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(returned, false, "an idempotent claim is not a state change");
  await unchanged;
  assert.equal((await store.wait(ownerId, 0.005)).status, "running");
  await store.finish(execution, final());
  assert.equal((await store.wait(ownerId, 25)).status, "completed");
  assert.equal(store.waiters.size, 0);
});

test("seven-day expiry uses original terminal time; delayed alarms and late callbacks cannot revive", async () => {
  for (const alarmFirst of [true, false]) {
    const { store, storage, advance } = await setup();
    await store.claim(execution);
    await store.finish(execution, final("PRIVATE_RESULT"));
    const deadline = await storage.getAlarm();
    advance(TASK_LIMITS.retentionMs - 1);
    await store.alarm();
    assert.equal(await storage.getAlarm(), deadline);
    assert.equal((await store.read(ownerId)).result.finalResponse, "PRIVATE_RESULT");
    await store.finish(execution, final("PRIVATE_RESULT"));
    assert.equal(await storage.getAlarm(), deadline);
    advance(1);
    if (alarmFirst) await store.alarm();
    for (const owner of [ownerId, "456"]) await assert.rejects(store.read(owner), code("TASK_NOT_FOUND"));
    assert.equal(await storage.get("task"), undefined, "not-found must not roll back expiry deletion");
    await assert.rejects(store.finish(execution, final("PRIVATE_RESULT")), code("TASK_NOT_FOUND"));
    await assert.rejects(store.claim(execution), code("TASK_NOT_FOUND"));
    await store.alarm();
    await store.alarm();
    assert.equal(await storage.get("task"), undefined);
    assert.equal(await storage.getAlarm(), undefined);
  }
});
