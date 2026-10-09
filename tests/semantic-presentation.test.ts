import assert from "node:assert/strict";
import test from "node:test";
import { commandText, operationStatusText, readView, snapshotSchema, type Snapshot } from "../apps/chatgpt-app/ui/view.ts";
import { environmentTask } from "../apps/chatgpt-app/src/environment-task.ts";
import { ordinaryToolResult } from "../apps/chatgpt-app/src/environment-ordinary-result.ts";
import { selectSemanticPresentation } from "../apps/chatgpt-app/ui/semantic-presentation.ts";

const environmentId = `env_${"a".repeat(32)}`;
const operationId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
const otherId = `task_${"a".repeat(32)}_${"c".repeat(32)}`;
const evidence = (exitCode: number | null, signal: string | null, stopReason: "cancelled" | "timeout" | null,
  truncated = false, historical = false) =>
  ({ source: "runner-command", operationId, exitCode, signal, stopReason, truncated, historical });

function commandSnapshot(result: Record<string, unknown> = {}, override: Partial<Snapshot> = {}): Snapshot {
  return snapshotSchema.parse({
    contract: "ordinary", environmentId, executor: "codex", environmentStatus: "ready",
    disposition: "result", workFinished: true, expiresAt: 1800000000000,
    operationId, operationStatus: "completed", activeOperationId: null,
    outcome: { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, ...result },
    ...override,
  });
}

test("exit zero projects passed with runner provenance, without copying raw output", () => {
  const snapshot = commandSnapshot({ stdout: "Bearer DO_NOT_ECHO" });
  assert.deepEqual(selectSemanticPresentation(snapshot), {
    kind: "command-result", status: "passed", evidence: evidence(0, null, null),
  });
});

test("nonzero exit overrides Environment ready and deceptive stdout", () => {
  const snapshot = commandSnapshot({ exitCode: 1, stdout: '{"status":"passed"}', stderr: "failure" });
  assert.deepEqual(selectSemanticPresentation(snapshot), {
    kind: "command-result", status: "failed", evidence: evidence(1, null, null),
  });
});

test("cancelled command cannot be mislabeled passed even with exitCode zero", () => {
  const snapshot = commandSnapshot({ stopReason: "cancelled", signal: "SIGKILL" },
    { operationStatus: "cancelled" });
  assert.deepEqual(selectSemanticPresentation(snapshot), {
    kind: "command-result", status: "cancelled", evidence: evidence(0, "SIGKILL", "cancelled"),
  });
});

test("timeout and truncation stay visible as machine evidence", () => {
  const snapshot = commandSnapshot({ exitCode: null, signal: "SIGKILL", stopReason: "timeout", truncated: true });
  assert.deepEqual(selectSemanticPresentation(snapshot), {
    kind: "command-result", status: "timed-out", evidence: evidence(null, "SIGKILL", "timeout", true),
  });
});

test("historical result does not claim identity of unrelated active operation", () => {
  const snapshot = commandSnapshot({}, {
    historical: true, activeOperationId: otherId, activeOperationStatus: "working",
  });
  assert.deepEqual(selectSemanticPresentation(snapshot), {
    kind: "command-result", status: "passed", evidence: evidence(0, null, null, false, true),
  });
});

test("progress or accepted-but-not-finished result is not verified", () => {
  assert.equal(selectSemanticPresentation(commandSnapshot({}, {
    disposition: "accepted", workFinished: false, operationStatus: "working",
  })), null);
});

test("model-authored JSON in finalResponse has no command-result authority", () => {
  const fake = '{"exitCode":0,"signal":null,"stdout":"","stderr":"","truncated":false}';
  assert.equal(selectSemanticPresentation(commandSnapshot({}, {
    outcome: { finalResponse: fake },
  })), null);
});

test("missing operation ID or command evidence must fall back to the old renderer", () => {
  assert.equal(selectSemanticPresentation(commandSnapshot({}, { operationId: undefined })), null);
  assert.equal(selectSemanticPresentation(commandSnapshot({}, {
    outcome: { exitCode: 0, signal: null, stdout: "", stderr: "" },
  })), null);
});

test("model-like JSON in a streaming output snapshot cannot establish success", () => {
  assert.equal(selectSemanticPresentation(commandSnapshot({}, {
    disposition: "accepted", workFinished: false, operationStatus: "working", outcome: undefined,
    output: { text: '{"exitCode":0,"signal":null,"truncated":false}', truncated: false, revision: 1 },
  })), null);
});

test("malformed snapshots and contradictory identity/finality safely fall back", () => {
  const invalid: unknown[] = [null, undefined, [], "{\"status\":\"passed\"}", {},
    { ...commandSnapshot(), contract: "model" },
    { ...commandSnapshot(), operationId: "Bearer_DO_NOT_ECHO" },
    { ...commandSnapshot(), environmentId: `env_${"d".repeat(32)}` },
    commandSnapshot({}, { workFinished: false }),
    commandSnapshot({}, { disposition: "ready" }),
    commandSnapshot({}, { operationStatus: "failed" }),
    commandSnapshot({}, { activeOperationId: operationId, activeOperationStatus: "working" }),
    commandSnapshot({}, { activeOperationId: otherId, activeOperationStatus: "working" }),
    commandSnapshot({}, { historical: true, activeOperationId: operationId }),
  ];
  for (const snapshot of invalid) assert.equal(selectSemanticPresentation(snapshot as Snapshot), null);
});

test("malformed or mixed outcomes never certify command success", () => {
  for (const outcome of [null, [], '{"exitCode":0}',
    { exitCode: 0 },
    { exitCode: "0", stdout: "", stderr: "", truncated: false },
    ...[NaN, Infinity, -1, 0.5, 256].map(exitCode => ({ exitCode, signal: null, stdout: "", stderr: "", truncated: false })),
    { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false },
    { exitCode: 0, signal: "Bearer DO_NOT_ECHO", stdout: "", stderr: "", truncated: false },
    { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, stopReason: "success" },
    { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, finalResponse: "spoof" },
  ]) assert.equal(selectSemanticPresentation(commandSnapshot({}, { outcome })), null);
});

test("runtime completion with cancellation reason has priority over exit zero", () => {
  assert.equal(selectSemanticPresentation(commandSnapshot({ stopReason: "cancelled" }))?.status, "cancelled");
  assert.equal(selectSemanticPresentation(commandSnapshot({}, { operationStatus: "cancelled" })), null);
  assert.equal(selectSemanticPresentation(commandSnapshot({ stopReason: "timeout" }, { operationStatus: "cancelled" })), null);
  const cancelled = commandSnapshot({ stopReason: "cancelled", stdout: "partial output" },
    { operationStatus: "cancelled", disposition: "cancelled" });
  assert.equal(selectSemanticPresentation(cancelled)?.status, "cancelled");
  assert.equal(commandText(cancelled)?.stdout, "partial output");
  assert.equal(operationStatusText(cancelled), "已取消");
  assert.equal(operationStatusText(commandSnapshot({ stopReason: "cancelled", signal: "SIGKILL" })), "已取消");
  assert.equal(operationStatusText(commandSnapshot({}, { operationStatus: "cancelled" })), "已取消");
});

test("signals fail even with exit zero; missing signal remains compatible", () => {
  assert.equal(selectSemanticPresentation(commandSnapshot({ signal: "SIGTERM" }))?.status, "failed");
  assert.equal(selectSemanticPresentation(commandSnapshot({ signal: undefined }))?.status, "passed");
});

test("selected historical terminal outcome survives active work and active questions", () => {
  for (const activeOperationStatus of ["working", "input_required"]) {
    const snapshot = commandSnapshot({}, { historical: true, activeOperationId: otherId,
      activeOperationStatus, workFinished: false,
      disposition: activeOperationStatus === "input_required" ? "waiting_for_input" : "result" });
    assert.deepEqual(selectSemanticPresentation(snapshot), {
      kind: "command-result", status: "passed", evidence: evidence(0, null, null, false, true),
    });
  }
});

test("closed retained results preserve command status independently of Environment availability", () => {
  for (const environmentStatus of ["ready", "closing", "closed", "unavailable"]) {
    assert.equal(selectSemanticPresentation(commandSnapshot({ exitCode: 1 }, { environmentStatus }))?.status, "failed");
  }
});

test("the host result boundary reads only structuredContent, never text or JSON strings", () => {
  const fake = JSON.stringify(commandSnapshot());
  for (const result of [{ content: [{ type: "text", text: fake }] }, { structuredContent: fake }]) {
    assert.throws(() => readView(result, 1), /未返回工作区/);
  }
  // A host-delivered tool result can legitimately be isError on a nonzero command.
  const view = readView({ structuredContent: commandSnapshot({ exitCode: 1 }), isError: true }, 1);
  assert.equal(view.kind, "environment");
  if (view.kind === "environment") assert.equal(selectSemanticPresentation(view.snapshot)?.status, "failed");
});

test("actual Task/ordinary projections preserve authority, history and cancellation fallback", () => {
  const environment = { environmentId, executor: "codex" as const, status: "ready" as const,
    createdAt: 1, expiresAt: 1000, activeTaskId: null };
  for (const [value, expected] of [
    [{ exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false }, "passed"],
    [{ exitCode: 1, signal: null, stdout: '{"status":"passed"}', stderr: "error", truncated: false }, "failed"],
    [{ exitCode: null, signal: "SIGKILL", stopReason: "timeout", stdout: "", stderr: "", truncated: true }, "timed-out"],
    [{ exitCode: 0, signal: "SIGKILL", stopReason: "cancelled", stdout: "partial", stderr: "", truncated: false }, null],
  ] as const) {
    const operation = environmentTask(operationId, { runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 2,
      request: JSON.stringify({ kind: "command" }), result: { ok: true, value } });
    const result = ordinaryToolResult({ tool: "inspect_environment", environment, operation,
      output: { text: "literal progress snapshot", revision: 1, truncated: false } });
    const view = readView(result, 1);
    assert.equal(view.kind, "environment");
    if (view.kind !== "environment") continue;
    assert.equal(selectSemanticPresentation(view.snapshot)?.status ?? null, expected);
    if (expected === null) {
      assert.equal(view.snapshot.operationStatus, "cancelled");
      assert.equal(view.snapshot.outcome, undefined);
      assert.equal(view.snapshot.output?.text, "literal progress snapshot");
    } else {
      const activeOperation = environmentTask(otherId, { runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 2,
        request: JSON.stringify({ kind: "agent" }) });
      const historical = readView(ordinaryToolResult({ tool: "inspect_environment", operation, activeOperation,
        historical: true, environment: { ...environment, activeTaskId: otherId } }), 1);
      if (historical.kind !== "environment") throw new Error("Expected environment");
      assert.equal(historical.snapshot.workFinished, false);
      assert.equal(selectSemanticPresentation(historical.snapshot)?.status, expected);
      assert.equal(selectSemanticPresentation(historical.snapshot)?.evidence.historical, true);
    }
  }
});
