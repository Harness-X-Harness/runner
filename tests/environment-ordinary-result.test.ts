import test from "node:test";
import assert from "node:assert/strict";
import { environmentTask } from "../apps/chatgpt-app/src/environment-task.ts";
import { lifecycleTask } from "../apps/chatgpt-app/src/environment-lifecycle-task.ts";
import { ordinaryToolResult } from "../apps/chatgpt-app/src/environment-ordinary-result.ts";
import type { EnvironmentSnapshot, OperationRecord } from "../apps/chatgpt-app/src/environment-object.ts";

const environmentId = `env_${"a".repeat(32)}`;
const taskId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
test("inspection exposes the current reconnect fact as observation, without a terminal outcome", () => {
  const diagnostic = { category: "transport_failure" as const, observedAt: 123 };
  const inspected = ordinaryToolResult({ tool: "inspect_environment", environment: environment("unavailable", {
    reason: "runtime_disconnected", reconnectDiagnostic: diagnostic,
  }) });
  assert.deepEqual(inspected.structuredContent?.reconnectDiagnostic, diagnostic);
  assert.equal(inspected.structuredContent?.workFinished, false);
  assert.equal(inspected.structuredContent?.outcome, undefined);
  assert.match(content(inspected), /transport_failure.*123/);
  assert.match(content(inspected), /observation.*not.*stop/i);
});
function environment(status: EnvironmentSnapshot["status"], extra: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return { environmentId, executor: "codex", status, createdAt: 1, expiresAt: 1000, activeTaskId: null, ...extra };
}
function operation(record: Partial<OperationRecord> & Pick<OperationRecord, "request">) {
  return environmentTask(taskId, { runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 2, ...record });
}
function content(result: ReturnType<typeof ordinaryToolResult>): string {
  return result.content.map(block => block.type === "text" ? block.text : "").join("\n");
}

test("only explicit inspection includes the model directory; outcomes keep native selection", () => {
  const selection = { model: "fixture-model", reasoningEffort: "high" };
  const agent = { state: { defaults: selection, selection, uncertain: false,
    models: [{ id: "fixture-model", effort: "high", efforts: ["high"] }] }, observedAt: 1, current: true };
  const snapshot = environment("ready", { agent });
  const result = operation({ request: JSON.stringify({ kind: "agent" }), result: {
    ok: true, value: { status: "completed", finalResponse: "DONE", ...selection },
  } });
  for (const tool of ["open_environment", "command", "agent", "update_operation", "close_environment"] as const) {
    const receipt = ordinaryToolResult({ tool, environment: snapshot, operation: result });
    assert.equal(receipt.structuredContent?.agent, undefined);
    assert.equal(receipt.structuredContent?.tool, tool);
    assert.deepEqual(receipt.structuredContent?.outcome,
      { status: "completed", finalResponse: "DONE", ...selection });
  }
  const inspected = ordinaryToolResult({ tool: "inspect_environment", environment: snapshot, operation: result });
  assert.deepEqual(inspected.structuredContent?.agent, agent);
});

test("successful reads and controls do not inherit the selected operation's error", () => {
  const cases = [
    ["command", operation({ request: JSON.stringify({ kind: "command" }), result: { ok: true, value: {
      exitCode: null, signal: "SIGTERM", stdout: "STOP_STARTED\n", stderr: "", truncated: false, stopReason: "cancelled",
    } } })],
    ["agent", operation({ request: JSON.stringify({ kind: "agent" }), result: { ok: true, value: { status: "cancelled" } } })],
    ["agent", operation({ request: JSON.stringify({ kind: "agent" }), result: { ok: false, code: "EXECUTOR_FAILED" } })],
    ["command", operation({ request: JSON.stringify({ kind: "command" }), result: { ok: true, value: {
      exitCode: 7, signal: null, stdout: "", stderr: "COMMAND_FAILED", truncated: false,
    } } })],
  ] as const;
  for (const [executionTool, selected] of cases) {
    const execution = ordinaryToolResult({ tool: executionTool, environment: environment("ready"), operation: selected });
    assert.equal(execution.isError, true);
    for (const tool of ["inspect_environment", "update_operation"] as const) {
      const receipt = ordinaryToolResult({ tool, environment: environment("ready"), operation: selected });
      assert.equal(receipt.isError, undefined, `${tool} reading ${selected.status}`);
      assert.equal(receipt.structuredContent?.operationStatus, selected.status);
      assert.equal(receipt.structuredContent?.workFinished, true);
      assert.equal(receipt.structuredContent?.disposition, execution.structuredContent?.disposition);
      assert.deepEqual(receipt.structuredContent?.outcome, execution.structuredContent?.outcome);
      assert.deepEqual(receipt.content, execution.content.map(block => block.type === "text"
        ? { ...block, text: block.text.replace(`Ordinary result for ${executionTool}.`, `Ordinary result for ${tool}.`) } : block));
    }
  }
});

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
      requestedSchema: { type: "object", properties: { name: { type: "string" } } } },
  } } } });
  const held = ordinaryToolResult({ tool: "agent", environment: environment("ready", { activeTaskId: taskId }), operation: waiting });
  assert.equal(held.isError, undefined);
  assert.equal(held.structuredContent?.disposition, "waiting_for_input");
  const questions = [{ id: "ask", operationId: taskId, message: "Which name?",
    requestedSchema: { type: "object", properties: { name: { type: "string" } } } }];
  assert.deepEqual(held.structuredContent?.questions, questions);
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
  assert.doesNotMatch(content(agent), /Agent model is/);
  const reported = operation({ request: JSON.stringify({ kind: "agent" }), result: { ok: true, value: {
    status: "completed", finalResponse: "AGENT_DONE", model: "gpt-6-sol", reasoningEffort: "high" } } });
  const selectedAgent = ordinaryToolResult({ tool: "agent", environment: environment("ready"), operation: reported });
  assert.match(content(selectedAgent), /This operation used agent model gpt-6-sol with reasoning effort high/);
  assert.equal(selectedAgent.structuredContent?.outcome && typeof selectedAgent.structuredContent.outcome === "object"
    && "model" in selectedAgent.structuredContent.outcome ? selectedAgent.structuredContent.outcome.model : undefined, "gpt-6-sol");
  const inspected = ordinaryToolResult({ tool: "inspect_environment", environment: environment("ready"), operation: reported });
  assert.match(content(inspected), /AGENT_DONE/);
  assert.deepEqual(inspected.structuredContent?.outcome, selectedAgent.structuredContent?.outcome);
  assert.equal(inspected.structuredContent?.expiresAt, 1000);

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
  assert.deepEqual(both.structuredContent?.questions, questions);
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
