import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentLifetime } from "../.github/actions/agent-runtime/environment-lifetime.ts";

test("close seals synchronously, runs cleanup once and waits for its observation", async () => {
  const cleanup = Promise.withResolvers<void>();
  let calls = 0;
  let settled = false;
  const lifetime = new EnvironmentLifetime(Date.now() + 10000, () => { calls++; return cleanup.promise; });
  lifetime.stopped.then(() => { settled = true; });
  const stopped = lifetime.close();
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(lifetime.close(), stopped);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(settled, false);
  cleanup.resolve();
  await stopped;
  assert.equal(settled, true);
});

test("idle lifetime reaches its deadline without another command or polling", async () => {
  let calls = 0;
  const lifetime = new EnvironmentLifetime(Date.now() + 30, async () => { calls++; });
  await lifetime.stopped;
  assert.equal(lifetime.signal.aborted, true);
  assert.equal(calls, 1);
  await lifetime.close();
  assert.equal(calls, 1);
});

test("expired lifetime starts sealed; failed cleanup never becomes successful stop", async () => {
  const failure = new Error("fixture cleanup unconfirmed");
  const lifetime = new EnvironmentLifetime(Date.now() - 1, async () => { throw failure; });
  assert.equal(lifetime.signal.aborted, true);
  await assert.rejects(lifetime.stopped, error => error === failure);
  await assert.rejects(lifetime.close(), error => error === failure);
  for (const deadline of [NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new EnvironmentLifetime(deadline, async () => {}), /INVALID_ENVIRONMENT_DEADLINE/);
  }
});
