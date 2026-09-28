import test from "node:test";
import assert from "node:assert/strict";
import { dispatchEnvironmentWorkflow } from "../apps/chatgpt-app/src/task-github.ts";

test("Environment dispatch sends only its identity and never retries an uncertain response", async () => {
  const env = { GITHUB_RUNNER_REPOSITORY: "fixture/runner", GITHUB_RUNNER_REF: "protected" };
  const environmentId = `env_${"a".repeat(32)}`;
  for (const [status, expected] of [[200, "accepted"], [204, "unknown"], [403, "rejected"], [422, "rejected"], [408, "unknown"], [503, "unknown"]] as const) {
    let calls = 0;
    assert.deepEqual(await dispatchEnvironmentWorkflow(env, "PRIVATE_TOKEN", environmentId, async (url, init) => {
      calls++;
      assert.equal(url, "https://api.github.com/repos/fixture/runner/actions/workflows/run-environment.yml/dispatches");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { ref: "protected", inputs: { environment_id: environmentId } });
      assert.ok(init?.signal);
      return status === 200 ? Response.json({ workflow_run_id: 123 }) : new Response(null, { status });
    }), expected === "accepted" ? { status: expected, runId: "123" } : { status: expected });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const unavailable: typeof fetch = async () => { calls++; throw new Error("PRIVATE_UPSTREAM_DETAILS"); };
  assert.deepEqual(await dispatchEnvironmentWorkflow(env, "PRIVATE_TOKEN", environmentId, unavailable), { status: "unknown" });
  assert.equal(calls, 1);
  await assert.rejects(dispatchEnvironmentWorkflow(env, "PRIVATE_TOKEN", "invalid", unavailable));
  assert.equal(calls, 1);
});
