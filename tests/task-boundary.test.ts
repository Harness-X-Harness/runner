import assert from "node:assert/strict";
import test from "node:test";
import { taskSnapshotSchema } from "../apps/chatgpt-app/src/task-request.ts";

test("the MCP output schema also validates and projects internal public Task responses", () => {
  const expected = {
    taskId: "task_fixture", executor: "codex", status: "completed",
    createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:01:00Z",
    result: { finalResponse: "done" },
  };
  assert.deepEqual(taskSnapshotSchema.parse({
    ...expected, prompt: "PRIVATE_PROMPT", execution: { token: "PRIVATE_TOKEN" },
    result: { ...expected.result, nativeDiagnostics: "PRIVATE_DIAGNOSTIC" },
  }), expected);
  assert.equal(taskSnapshotSchema.safeParse({ ...expected, result: { finalResponse: 42 } }).success, false);
  assert.equal(taskSnapshotSchema.safeParse({ ...expected, status: "not-a-task-status" }).success, false);
});
