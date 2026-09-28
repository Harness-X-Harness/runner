import assert from "node:assert/strict";
import test from "node:test";
import { observeWorkflowExecution, requestWorkflowStop } from "../apps/chatgpt-app/src/task-github.ts";
import { ENVIRONMENT_WORKFLOW } from "../apps/chatgpt-app/src/environment-callback.ts";

test("Environment stop evidence names the exact workflow, owner, run and attempt", async () => {
  const execution = { repository: "fixture/runner", ownerId: "12", runId: "34", runAttempt: "1" };
  const evidence = { id: 34, run_attempt: 1, repository: { full_name: execution.repository },
    actor: { id: 12 }, path: `.github/workflows/${ENVIRONMENT_WORKFLOW}`, status: "completed", conclusion: "cancelled" };
  const observe = (change: Record<string, unknown> = {}, status = 200) => observeWorkflowExecution(
    "fixture-token", execution, ENVIRONMENT_WORKFLOW, async (url, init) => {
      assert.equal(url, "https://api.github.com/repos/fixture/runner/actions/runs/34/attempts/1");
      assert.ok(init?.signal);
      return Response.json({ ...evidence, ...change }, { status });
    });
  assert.deepEqual(await observe(), { status: "completed", conclusion: "cancelled" });
  assert.deepEqual(await observe({ status: "in_progress", conclusion: null }), { status: "in_progress" });
  for (const change of [{ id: 35 }, { run_attempt: 2 }, { actor: { id: 13 } },
    { repository: { full_name: "other/runner" } }, { path: ".github/workflows/run-task.yml" },
    { conclusion: null }]) await assert.rejects(observe(change));
  for (const status of [401, 404, 503]) await assert.rejects(observe({}, status));
});

test("backend stop checks the current execution; accepted cancellation is not stopped evidence", async () => {
  const execution = { repository: "fixture/runner", ownerId: "12", runId: "34", runAttempt: "1" };
  const evidence = { id: 34, run_attempt: 1, repository: { full_name: execution.repository },
    actor: { id: 12 }, path: `.github/workflows/${ENVIRONMENT_WORKFLOW}`, status: "in_progress", conclusion: null };
  const calls: string[] = [];
  const request = (change: Record<string, unknown> = {}, cancelStatus = 202) => requestWorkflowStop(
    "fixture-token", execution, ENVIRONMENT_WORKFLOW, async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/cancel")) return new Response(null, { status: cancelStatus });
      return Response.json({ ...evidence, ...change });
    });
  assert.equal(await request(), "requested");
  assert.deepEqual(calls, ["GET https://api.github.com/repos/fixture/runner/actions/runs/34",
    "POST https://api.github.com/repos/fixture/runner/actions/runs/34/cancel"]);
  calls.length = 0;
  assert.equal(await request({ status: "completed", conclusion: "success" }), "completed");
  assert.equal(calls.length, 1);
  for (const change of [{ run_attempt: 2 }, { actor: { id: 13 } }, { path: ".github/workflows/other.yml" }]) {
    calls.length = 0;
    await assert.rejects(request(change));
    assert.equal(calls.length, 1);
  }
  for (const status of [401, 409, 503]) await assert.rejects(request({}, status));
});
