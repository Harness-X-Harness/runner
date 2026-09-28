import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentCiWaits } from "../.github/actions/agent-runtime/environment-ci-waits.ts";

const target = { repository: "fixture/repo", runId: "12", runAttempt: 1, revision: "a".repeat(40) };

test("runtime CI wait preserves identity across connections and waits for durable result delivery", async () => {
  const waits = new EnvironmentCiWaits();
  const signal = new AbortController();
  const registration = waits.register("task", target, signal.signal);
  const pending = waits.pending()[0]!;
  let registered = false; void registration.then(() => { registered = true; });
  await Promise.resolve(); assert.equal(registered, false);
  assert.deepEqual(waits.pending(), [pending]);
  waits.accept("task", pending.waitId);
  const observer = await registration;
  const result = { ...target, conclusion: "success" as const };
  let committed = false; const commit = observer.commit(result).then(() => { committed = true; });
  await Promise.resolve(); assert.equal(committed, false);
  assert.deepEqual(waits.pending(), [{ ...pending, observation: result }]);
  assert.throws(() => waits.complete("task", pending.waitId, { ...result, runAttempt: 2 }));
  waits.complete("task", pending.waitId, result);
  await commit; assert.deepEqual(await observer.result, result);
  waits.complete("task", pending.waitId, result);
  assert.throws(() => waits.complete("task", pending.waitId, { ...result, conclusion: "failure" }), /CONFLICT/);
  assert.deepEqual(waits.pending(), []);
  await observer.close(); await observer.close();
});

test("cancellation and late delivery do not revive a native wait", async () => {
  const waits = new EnvironmentCiWaits();
  const abort = new AbortController();
  const registration = waits.register("task", target, abort.signal);
  const pending = waits.pending()[0]!;
  waits.accept("task", pending.waitId);
  const observer = await registration;
  abort.abort();
  await assert.rejects(observer.result, /CI_WAIT_CANCELLED/);
  waits.complete("task", pending.waitId, { ...target, conclusion: "success" });
  assert.deepEqual(waits.pending(), []);
  const other = waits.register("other", target, new AbortController().signal);
  waits.cancel("other");
  await assert.rejects(other, /CI_WAIT_CANCELLED/);
});
