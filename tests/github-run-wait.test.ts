import test from "node:test";
import assert from "node:assert/strict";
import { waitForGithubRun, type GithubRunCompletion } from "../.github/actions/agent-runtime/github-run-wait.ts";

const input = { repository: "fixture/repo", runId: "123", runAttempt: 2, revision: "a".repeat(40) };
const completed: GithubRunCompletion = { ...input, conclusion: "success" };
const observation = (status: string, overrides = {}) => Response.json({ id: 123, run_attempt: 2,
  head_sha: input.revision, repository: { full_name: input.repository }, status,
  conclusion: status === "completed" ? "success" : null, ...overrides });

test("registration precedes one authority read and an early completion is committed before delivery", async () => {
  const events: string[] = [];
  const committed = Promise.withResolvers<GithubRunCompletion>();
  const commitStarted = Promise.withResolvers<void>();
  const allowCommit = Promise.withResolvers<void>();
  const result = waitForGithubRun(input, "fixture-work-token", new AbortController().signal, async target => {
    assert.deepEqual(target, input); events.push("register");
    return { result: committed.promise, async commit(value) {
      events.push("commit-start"); commitStarted.resolve(); await allowCommit.promise;
      events.push("commit-durable"); committed.resolve(value);
    }, async close() { events.push("close"); } };
  }, async (url, options) => {
    events.push("read");
    assert.equal(url, "https://api.github.com/repos/fixture/repo/actions/runs/123/attempts/2");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture-work-token");
    assert.equal(options?.redirect, "error");
    return observation("completed");
  });
  let returned = false; void result.then(() => { returned = true; });
  await commitStarted.promise;
  assert.equal(returned, false);
  assert.deepEqual(events, ["register", "read", "commit-start"]);
  allowCommit.resolve();
  assert.deepEqual(await result, completed);
  assert.deepEqual(events, ["register", "read", "commit-start", "commit-durable", "close"]);
});

test("a completion racing the initial read is retained, but cannot bypass work authorization", async () => {
  for (const status of [200, 403]) {
    let reads = 0; let closed = false;
    const event = Promise.withResolvers<GithubRunCompletion>();
    const result = waitForGithubRun(input, "fixture", new AbortController().signal, async () => ({
      result: event.promise, async commit() { assert.fail("pending observation must not overwrite the event"); },
      async close() { closed = true; },
    }), async () => {
      reads++; event.resolve(completed);
      return status === 200 ? observation("in_progress") : new Response(null, { status });
    });
    if (status === 200) assert.deepEqual(await result, completed);
    else await assert.rejects(result, /CI_WORK_AUTHORITY_DENIED/);
    assert.equal(reads, 1); assert.equal(closed, true);
  }
});

test("uncovered targets, wrong identity and cancellation never become CI success", async () => {
  let reads = 0;
  await assert.rejects(waitForGithubRun(input, "fixture", new AbortController().signal,
    async () => { throw new Error("CI_EVENT_COVERAGE_REQUIRED"); },
    async () => { reads++; return observation("completed"); }), /CI_EVENT_COVERAGE_REQUIRED/);
  assert.equal(reads, 0);
  for (const overrides of [{ run_attempt: 3 }, { id: 124 }, { head_sha: "b".repeat(40) },
    { repository: { full_name: "other/repo" } }]) {
    let closed = false;
    await assert.rejects(waitForGithubRun(input, "fixture", new AbortController().signal, async () => ({
      result: Promise.resolve(completed), async commit() { assert.fail("mismatched observation must not commit"); },
      async close() { closed = true; },
    }), async () => observation("completed", overrides)), /CI_WAIT_IDENTITY_MISMATCH/);
    assert.equal(closed, true);
  }
  const abort = new AbortController();
  let closed = false;
  await assert.rejects(waitForGithubRun(input, "fixture", abort.signal, async () => ({
    result: Promise.resolve(completed), async commit() { assert.fail("cancelled read must not commit"); },
    async close() { closed = true; },
  }), async () => { abort.abort(); return observation("completed"); }), { name: "AbortError" });
  assert.equal(closed, true);
});
