import assert from "node:assert/strict";
import test from "node:test";

import { applyTaskEvent, publicTask, validateSubmitInput } from "../apps/chatgpt-app/src/task.js";
import { TOOL_CONTRACT } from "../apps/chatgpt-app/src/tool-contract.js";

test("tool contract separates task reads from writes", () => {
  assert.deepEqual(TOOL_CONTRACT, [
    { name: "submit_task", readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    { name: "get_task", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    { name: "cancel_task", readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    { name: "get_task_result", readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  ]);
});

test("submit input is normalized to the task contract", () => {
  assert.deepEqual(validateSubmitInput({
    repo: "owner/project",
    prompt: "Implement the feature",
    executor: "codex",
    mode: "pull_request",
  }), {
    repo: "owner/project",
    ref: "main",
    prompt: "Implement the feature",
    executor: "codex",
    mode: "pull_request",
  });
});

test("public task data never includes prompt or callback credentials", () => {
  const safe = publicTask({
    id: "task_123",
    prompt: "private instructions",
    callbackToken: "one-time-token",
    error: "private callback failure",
    status: "queued",
    ownerId: "github:42",
    result: { commit: "abc123", summary: "changed files", secret: "must not escape" },
  });
  assert.deepEqual(safe, {
    id: "task_123",
    status: "queued",
    result: { commit: "abc123", summary: "changed files" },
  });
  assert.equal(safe.ownerId, undefined);
  assert.equal(safe.error, undefined);
});

test("callback events update status and result without changing task identity", () => {
  const task = {
    id: "task_123",
    repo: "owner/project",
    status: "queued",
    createdAt: "2026-07-24T00:00:00.000Z",
  };
  const updated = applyTaskEvent(task, {
    status: "completed",
    runId: 42,
    result: { commit: "abc123" },
  });

  assert.equal(updated.id, "task_123");
  assert.equal(updated.repo, "owner/project");
  assert.equal(updated.status, "completed");
  assert.equal(updated.runId, "42");
  assert.deepEqual(updated.result, { commit: "abc123" });
  assert.notEqual(updated.updatedAt, undefined);
});

test("callback events reject unknown lifecycle states", () => {
  assert.throws(
    () => applyTaskEvent({ id: "task_123", status: "queued" }, { status: "secret_leak" }),
    /status must be one of/,
  );
});

test("cancelled tasks cannot be revived by a late callback", () => {
  const task = { id: "task_123", status: "cancel_requested" };
  assert.equal(applyTaskEvent(task, { status: "running" }).status, "cancelled");
  assert.equal(applyTaskEvent({ id: "task_123", status: "completed" }, { status: "failed" }).status, "completed");
});
