import test from "node:test";
import assert from "node:assert/strict";
import { environmentTask } from "../apps/chatgpt-app/src/environment-task.ts";
import { runCommand } from "../.github/actions/agent-runtime/command.ts";

test("standard Task projection uses durable timestamps and excludes private execution input", () => {
  const record = { request: JSON.stringify({ kind: "agent", prompt: "PRIVATE_PROMPT" }), runtimeId: "PRIVATE_RUNTIME", createdAt: 1000, updatedAt: 2000 };
  const pending = environmentTask("task_one", record);
  assert.equal(pending.status, "working");
  assert.equal(pending.createdAt, new Date(1000).toISOString());
  assert.equal(pending.lastUpdatedAt, new Date(2000).toISOString());
  assert.equal(pending.ttlMs, null);
  const value = { status: "completed", finalResponse: "answer" };
  const complete = environmentTask("task_one", { ...record, result: { ok: true, value } });
  assert.equal(complete.status, "completed");
  if (complete.status === "completed") assert.deepEqual(complete.result.structuredContent, value);
  const selected = { ...value, model: "gpt-6.1-sol", reasoningEffort: "high" };
  const reported = environmentTask("task_one", { ...record, result: { ok: true, value: selected } });
  if (reported.status === "completed") assert.deepEqual(reported.result.structuredContent, selected);
  const failed = environmentTask("task_one", { ...record, result: { ok: false, code: "OPERATION_FAILED" } });
  assert.equal(failed.status, "failed");
  const ended = environmentTask("task_one", { ...record, cancelRequested: true,
    result: { ok: false, code: "ENVIRONMENT_ENDED_OUTCOME_UNKNOWN" } });
  assert.equal(ended.status, "failed");
  if (ended.status === "failed") assert.match(ended.error.message, /Effects may have occurred; do not automatically retry/);
  for (const result of [pending, complete, failed]) assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.throws(() => environmentTask("task_one", { ...record, result: { ok: false, code: "raw secret detail" } }));
});

test("command failure remains a completed error result; native cancellation is not success", () => {
  const record = { request: JSON.stringify({ kind: "command" }), runtimeId: "runtime", createdAt: 1, updatedAt: 2 };
  const command = { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false };
  for (const value of [command, { ...command, exitCode: 1 },
    { ...command, exitCode: null, signal: "SIGKILL", stopReason: "timeout" }]) {
    const task = environmentTask("task_one", { ...record, result: { ok: true, value } });
    assert.equal(task.status, "completed");
    if (task.status === "completed") assert.equal(task.result.isError, value.exitCode !== 0);
  }
  for (const [kind, value] of [["command", { ...command, stopReason: "cancelled" }],
    ["agent", { status: "cancelled" }]] as const) {
    assert.equal(environmentTask("task_one", { ...record, request: JSON.stringify({ kind }),
      result: { ok: true, value } }).status, "cancelled");
  }
});

test("a real failed command preserves output and exit code in the standard tool result", async () => {
  const input = { argv: [process.execPath, "-e", "process.stdout.write('output'); process.exitCode = 7"] as [string, ...string[]], timeoutSeconds: 5 };
  const value = await runCommand(input, { workspace: process.cwd(), deadline: Date.now() + 10000,
    env: {}, signal: new AbortController().signal });
  const task = environmentTask("task_one", { request: JSON.stringify({ kind: "command", ...input }),
    runtimeId: "runtime", createdAt: 1, updatedAt: 2, result: { ok: true, value } });
  assert.equal(task.status, "completed");
  if (task.status === "completed") {
    assert.equal(task.result.isError, true);
    assert.deepEqual(task.result.structuredContent, value);
    assert.equal(value.exitCode, 7);
    assert.equal(value.stdout, "output");
  }
});
