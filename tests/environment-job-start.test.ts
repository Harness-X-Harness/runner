import assert from "node:assert/strict";
import test from "node:test";
import { observeJobStart } from "../apps/chatgpt-app/src/task-github.ts";

test("job start uses the bound attempt, never observation time or another job", async () => {
  const execution = { repository: "fixture/runner", ownerId: "12", runId: "34", runAttempt: "2" };
  const job = { run_id: 34, name: "Environment", started_at: "2026-09-28T01:00:00Z" };
  const observe = (body: unknown, status = 200) => observeJobStart("fixture-token", execution, "Environment", async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/fixture/runner/actions/runs/34/attempts/2/jobs?per_page=100");
    assert.ok(init?.signal);
    return Response.json(body, { status });
  });
  const evidence = { total_count: 1, jobs: [job] };
  assert.equal(await observe(evidence), Date.parse(job.started_at));
  assert.equal(await observe(evidence), Date.parse(job.started_at));
  for (const body of [
    { total_count: 0, jobs: [] },
    { total_count: 2, jobs: [job] },
    { total_count: 2, jobs: [job, job] },
    ...[{ run_id: 35 }, { name: "Other" }, { started_at: null }, { started_at: "invalid" }]
      .map(change => ({ total_count: 1, jobs: [{ ...job, ...change }] })),
  ]) await assert.rejects(observe(body));
  for (const status of [401, 403, 404, 503]) await assert.rejects(observe(evidence, status));
});
