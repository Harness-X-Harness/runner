import test from "node:test";
import assert from "node:assert/strict";
import { environmentTask } from "../apps/chatgpt-app/src/environment-task.ts";
import { lifecycleTask } from "../apps/chatgpt-app/src/environment-lifecycle-task.ts";
import { ordinaryToolResult } from "../apps/chatgpt-app/src/environment-ordinary-result.ts";
import type { EnvironmentSnapshot, OperationRecord } from "../apps/chatgpt-app/src/environment-object.ts";

const environmentId = `env_${"a".repeat(32)}`;
const taskId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
function environment(status: EnvironmentSnapshot["status"], extra: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return { environmentId, executor: "codex", status, createdAt: 1, expiresAt: 1000, activeTaskId: null, ...extra };
}
function operation(record: Partial<OperationRecord> & Pick<OperationRecord, "request">) {
  return environmentTask(taskId, { runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 2, ...record });
}
function content(result: ReturnType<typeof ordinaryToolResult>): string {
  return result.content.map(block => block.type === "text" ? block.text : "").join("\n");
}

test("ordinary receipts keep acceptance, input, and completion distinct", () => {
  const opening = ordinaryToolResult({ tool: "open_environment", dispatch: "accepted", environment: environment("opening"),
    operation: lifecycleTask(environmentId, "open", { createdAt: 1, updatedAt: 2, status: "working" }) });
  assert.equal(opening.resultType, "complete");
  assert.equal(opening.isError, undefined);
  assert.equal(opening.structuredContent?.workFinished, false);
  assert.equal(opening.structuredContent?.environmentStatus, "opening");
  assert.match(content(opening), /is opening/);
  assert.match(content(opening), /Do not poll/);
  assert.doesNotMatch(content(opening), /is ready|is closed/);

  const closing = ordinaryToolResult({ tool: "close_environment", environment: environment("closing"),
    operation: lifecycleTask(environmentId, "close", { createdAt: 1, updatedAt: 2, status: "working" }) });
  assert.equal(closing.structuredContent?.workFinished, false);
  assert.match(content(closing), /closing is not closed/);

  const closed = ordinaryToolResult({ tool: "close_environment", environment: environment("closed"),
    operation: lifecycleTask(environmentId, "close", { createdAt: 1, updatedAt: 2, status: "completed" }) });
  assert.equal(closed.structuredContent?.workFinished, true);
  assert.match(content(closed), /closed confirms capacity release/);
  assert.doesNotMatch(content(closed), /Do not poll/);

  const waiting = operation({ request: JSON.stringify({ kind: "agent" }), inputs: { ask: { request: {
    method: "elicitation/create", params: { mode: "form", message: "Which name?",
      requestedSchema: { secret: "PRIVATE_SCHEMA" } },
  } } } });
  const held = ordinaryToolResult({ tool: "agent", environment: environment("ready", { activeTaskId: taskId }), operation: waiting });
  assert.equal(held.isError, undefined);
  assert.equal(held.structuredContent?.disposition, "waiting_for_input");
  assert.deepEqual(held.structuredContent?.questions, [{ id: "ask", message: "Which name?" }]);
  assert.match(content(held), /not success/);
  assert.doesNotMatch(JSON.stringify(held), /PRIVATE_SCHEMA|PRIVATE_RUNTIME/);

  const done = operation({ request: JSON.stringify({ kind: "command" }), result: { ok: true, value: {
    exitCode: 7, signal: null, stdout: "FAST_RESULT", stderr: "", truncated: false } } });
  const command = ordinaryToolResult({ tool: "command", environment: environment("ready"), operation: done });
  assert.equal(command.isError, true);
  assert.equal(command.structuredContent?.workFinished, true);
  assert.match(content(command), /FAST_RESULT/);
  assert.doesNotMatch(content(command), /Do not poll|certify/);

  const answer = operation({ request: JSON.stringify({ kind: "agent" }), result: { ok: true, value: {
    status: "completed", finalResponse: "AGENT_DONE" } } });
  const agent = ordinaryToolResult({ tool: "agent", environment: environment("ready"), operation: answer });
  assert.match(content(agent), /AGENT_DONE/);
  assert.match(content(agent), /does not certify/);

  const rejected = ordinaryToolResult({ tool: "open_environment", dispatch: "rejected",
    environment: environment("closing"), operation: lifecycleTask(environmentId, "open",
      { createdAt: 1, updatedAt: 2, status: "working" }) });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent?.workFinished, false);
  assert.match(content(rejected), /Dispatch was rejected/);
  assert.match(content(rejected), /closing is not closed/);

  const selectedId = `task_${"a".repeat(32)}_${"c".repeat(32)}`;
  const selected = environmentTask(selectedId, { request: JSON.stringify({ kind: "command" }), runtimeId: "PRIVATE_RUNTIME",
    createdAt: 1, updatedAt: 2, result: { ok: true, value: { exitCode: 0, signal: null, stdout: "OLD_RESULT", stderr: "", truncated: false } } });
  const both = ordinaryToolResult({ tool: "inspect_environment", historical: true, operation: selected, activeOperation: waiting,
    environment: environment("ready", { activeTaskId: taskId }) });
  assert.equal(both.structuredContent?.workFinished, false);
  assert.equal(both.structuredContent?.disposition, "waiting_for_input");
  assert.equal(both.structuredContent?.operationId, selectedId);
  assert.equal(both.structuredContent?.operationStatus, "completed");
  assert.equal(both.structuredContent?.activeOperationStatus, "input_required");
  assert.deepEqual(both.structuredContent?.questions, [{ id: "ask", message: "Which name?" }]);
  assert.match(content(both), /OLD_RESULT/);
  assert.match(content(both), /Which name\?/);
  assert.match(content(both), /not success/);
  assert.doesNotMatch(JSON.stringify(both), /PRIVATE_SCHEMA|PRIVATE_RUNTIME/);

  const disconnected = ordinaryToolResult({ tool: "open_environment",
    environment: environment("unavailable", { reason: "runtime_disconnected" }),
    operation: lifecycleTask(environmentId, "open", { createdAt: 1, updatedAt: 2, status: "completed" }) });
  assert.equal(disconnected.structuredContent?.workFinished, false);
  assert.equal(disconnected.structuredContent?.disposition, "unavailable");
  assert.equal(disconnected.structuredContent?.environmentStatus, "unavailable");
  assert.match(content(disconnected), /not ready/);
  assert.doesNotMatch(content(disconnected), /is ready/);
});
