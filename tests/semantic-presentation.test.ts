import assert from "node:assert/strict";
import test from "node:test";
import { snapshotSchema, type Snapshot } from "../apps/chatgpt-app/ui/view.ts";
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
