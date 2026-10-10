import assert from "node:assert/strict";
import test from "node:test";
import { environmentTaskAuthority } from "../apps/chatgpt-app/src/environment-task-authority.ts";
import type { EnvironmentSnapshot, OperationRecord } from "../apps/chatgpt-app/src/environment-object.ts";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";
import { CallToolResultV2Schema } from "../apps/chatgpt-app/node_modules/@modelcontextprotocol/ext-tasks/dist/core/v2/index.js";
import { readView, refreshArguments, cancelArguments } from "../apps/chatgpt-app/ui/view.ts";
import { selectSemanticPresentation } from "../apps/chatgpt-app/ui/semantic-presentation.ts";

const environmentId = `env_${"a".repeat(32)}`;
const otherId = `env_${"b".repeat(32)}`;
const operationId = `task_${"a".repeat(32)}_${"c".repeat(32)}`;
const oldId = `task_${"a".repeat(32)}_${"d".repeat(32)}`;
const props = { githubUserId: "123", githubAuthorizationKind: "github_app_scoped",
  environmentGithubAccessToken: "fixture-token", oauthScopes: ["environments:use"] };
const snapshot: EnvironmentSnapshot = { environmentId, executor: "codex", status: "ready",
  createdAt: 1, expiresAt: 1000, idleExpiresAt: 500, activeTaskId: null,
  agent: { state: { defaults: { model: "fixture-model", reasoningEffort: "high" },
    models: [], selection: null, uncertain: false }, observedAt: 2, current: true },
  reconnectDiagnostic: { category: "transport_closed", observedAt: 2 } };

function fixture(ids = [environmentId]) {
  const state = { ids, owner: "123", scopes: ["environments:use"], reads: 0,
    snapshot: { ...snapshot } as EnvironmentSnapshot | null,
    later: undefined as EnvironmentSnapshot | null | undefined,
    failure: "", directoryFailure: false, staleMembership: false, operationFailure: false, outputFailure: false, mutations: [] as string[],
    records: new Map<string, OperationRecord>(), owners: [] as string[] };
  const object = new Proxy({
    async readEnvironment(owner: string) {
      state.owners.push(owner); state.reads++;
      if (state.failure) throw new Error(state.failure);
      if (owner !== "123") return null;
      return state.reads > 1 && state.later !== undefined ? state.later : state.snapshot;
    },
    async readOperation(owner: string, id: string) {
      state.owners.push(owner);
      if (state.operationFailure) throw new Error("OPERATION_READ_FAILED");
      return owner === "123" ? state.records.get(id) ?? null : null;
    },
    async readOutput(owner: string) {
      state.owners.push(owner);
      if (state.outputFailure) throw new Error("OUTPUT_READ_FAILED");
      return owner === "123" ? { revision: 1, text: "TRUSTED_RAW_OUTPUT", truncated: false } : null;
    },
  }, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    return async () => { state.mutations.push(String(key)); throw new Error(`Unexpected ${String(key)}`); };
  } });
  // A read-only double traps every mutation, subscription and lifecycle method.
  const env = { ENVIRONMENT_ADMISSION: { getByName() { return {
    async list(owner: string) {
      state.owners.push(owner);
      if (state.directoryFailure) throw new Error("DIRECTORY_READ_FAILED");
      return owner === "123" || state.staleMembership ? state.ids : [];
    },
  }; } }, ENVIRONMENTS: { getByName(id: string) {
    if (id === otherId) return new Proxy(object, { get(target, key) {
      if (key === "readEnvironment") return async (owner: string) => {
        state.owners.push(owner);
        return owner === "123" ? { ...snapshot, environmentId: otherId, executor: "grok" } : null;
      };
      return Reflect.get(target, key);
    } });
    assert.equal(id, environmentId); return object;
  } } } as unknown as Parameters<typeof environmentTaskAuthority>[0];
  const authority = environmentTaskAuthority(env, async () => ({ ...props, githubUserId: state.owner, oauthScopes: state.scopes }));
  const call = async (name = "show_workbench", args: Record<string, unknown> = {}, capable = false) => {
    const result = CallToolResultV2Schema.parse(await authority.call({
      jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name, arguments: args, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": capable ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {},
      } },
    }));
    return z.object({ resultType: z.literal("complete"), isError: z.boolean().optional(),
      content: z.unknown().optional(), structuredContent: z.record(z.string(), z.unknown()).optional(),
    }).parse(result);
  };
  return { state, call, authority };
}

test("show_workbench returns zero/multiple owner directory views without guessing or creating", async () => {
  // Production admits one per owner; a defensive multi-entry double still needs a safe chooser.
  for (const ids of [[], [environmentId, otherId]]) {
    const { state, call } = fixture(ids);
    const result = await call();
    const view = readView(result, 3);
    assert.equal(view.kind, "list");
    if (view.kind !== "list") throw new Error("Expected chooser");
    assert.deepEqual(view.environments.map(e => e.environmentId), ids);
    assert.deepEqual(state.owners, Array(1 + ids.length).fill("123"));
    assert.deepEqual(state.mutations, []);
    assert.equal(result.resultType, "complete");
  }
});

test("one owned live Environment opens directly with the latest ordinary inspect projection", async () => {
  for (const status of ["opening", "ready", "unavailable", "closing"] as const) {
    for (const capable of [false, true]) {
      const { state, call } = fixture();
      state.snapshot!.status = status;
      state.later = { ...state.snapshot!, expiresAt: 900, idleExpiresAt: 400 };
      const result = await call("show_workbench", {}, capable);
      const inspected = await call("inspect_environment", { environmentId });
      assert.deepEqual(result.structuredContent, { ...inspected.structuredContent, tool: "show_workbench" });
      const view = readView(result, 3);
      assert.equal(view.kind, "environment");
      if (view.kind !== "environment") throw new Error("Expected direct view");
      assert.equal(view.snapshot.environmentStatus, status);
      assert.equal(view.snapshot.expiresAt, 900);
      assert.equal(view.snapshot.idleExpiresAt, 400);
      assert.deepEqual(view.snapshot.reconnectDiagnostic, snapshot.reconnectDiagnostic);
      assert.deepEqual(view.snapshot.agent, snapshot.agent);
      assert.deepEqual(refreshArguments(view), { name: "inspect_environment", arguments: { environmentId } });
      assert.equal(result.resultType, "complete");
      assert.equal(result.isError, undefined);
      assert.deepEqual(state.mutations, []);
    }
  }
});

test("re-entry retains trusted active command evidence and separately selected historical result", async () => {
  const { state, call } = fixture();
  const outcome = { exitCode: 7, signal: null, stdout: '{"status":"passed"}', stderr: "failure", truncated: false };
  const completed = { request: JSON.stringify({ kind: "command" }), runtimeId: "fixture", createdAt: 1, updatedAt: 2,
    result: { ok: true, value: outcome } };
  state.records.set(operationId, completed);
  state.snapshot!.activeTaskId = operationId;
  const result = await call();
  assert.equal(result.isError, undefined, "A successful read of failed work is not a failed tool");
  const view = readView(result, 3);
  if (view.kind !== "environment") throw new Error("Expected snapshot");
  assert.equal(view.snapshot.operationId, operationId);
  assert.equal(view.snapshot.activeOperationId, operationId);
  assert.deepEqual(view.snapshot.outcome, outcome);
  assert.equal(view.snapshot.output?.text, "TRUSTED_RAW_OUTPUT");
  assert.equal(selectSemanticPresentation(view.snapshot), null, "A still-active ID cannot invent terminal panel evidence");
  state.records.set(oldId, completed);
  state.records.set(operationId, { ...completed, result: undefined });
  const history = readView(await call("inspect_environment", { environmentId, operationId: oldId }), 4);
  if (history.kind !== "environment") throw new Error("Expected history");
  assert.equal(history.snapshot.historical, true);
  assert.equal(history.snapshot.workFinished, false);
  assert.equal(history.snapshot.operationId, oldId);
  assert.deepEqual(history.snapshot.outcome, outcome);
  assert.equal(selectSemanticPresentation(history.snapshot)?.status, "failed");
  assert.deepEqual(cancelArguments(history.snapshot), { operationId, action: "cancel" });
  const current = readView(await call(), 5);
  if (current.kind !== "environment") throw new Error("Expected current view");
  assert.equal(current.snapshot.operationId, operationId, "Zero args selects current server operation, not an old card's choice");
  assert.equal(current.snapshot.operationStatus, "working");
  assert.equal(current.snapshot.outcome, undefined);
  assert.deepEqual(state.mutations, []);
});

test("show_workbench fails closed on directory, snapshot, output and authorization failures", async () => {
  const { state, call, authority } = fixture();
  state.directoryFailure = true;
  await assert.rejects(call(), /DIRECTORY_READ_FAILED/);
  state.directoryFailure = false; state.failure = "SNAPSHOT_READ_FAILED";
  await assert.rejects(call(), /SNAPSHOT_READ_FAILED/);
  state.failure = ""; state.owner = "456";
  assert.equal(readView(await call(), 2).kind, "list");
  state.staleMembership = true;
  await assert.rejects(call(), { code: "RESOURCE_NOT_FOUND" });
  state.owner = "123"; state.scopes = [];
  await assert.rejects(call(), { code: "TASK_AUTH_REQUIRED" });
  await assert.rejects(authority.tools(), { code: "TASK_AUTH_REQUIRED" });
  state.scopes = ["environments:use"]; state.snapshot!.activeTaskId = operationId;
  state.records.set(operationId, { request: '{"kind":"command"}', runtimeId: "fixture", createdAt: 1, updatedAt: 1 });
  state.operationFailure = true;
  await assert.rejects(call(), /OPERATION_READ_FAILED/);
  state.operationFailure = false; state.outputFailure = true;
  await assert.rejects(call(), /OUTPUT_READ_FAILED/);
  assert.deepEqual(state.mutations, []);
});

test("show_workbench handles read races honestly and rejects nonempty input before reads", async () => {
  const { state, call } = fixture();
  const invalid = await call("show_workbench", { environmentId: "PRIVATE_INPUT" });
  assert.equal(invalid.isError, true);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_INPUT/);
  assert.equal(state.reads, 0);
  state.later = null;
  const missing = await call();
  assert.equal(missing.isError, true);
  assert.throws(() => readView(missing, 3), /Environment not found/);
  state.reads = 0;
  state.later = { ...snapshot, status: "closed" };
  const closed = readView(await call(), 4);
  if (closed.kind !== "environment") throw new Error("Expected retained closed snapshot");
  assert.equal(closed.snapshot.environmentStatus, "closed");
  state.reads = 0;
  state.later = { ...snapshot, activeTaskId: operationId };
  const raced = readView(await call(), 5);
  if (raced.kind !== "environment") throw new Error("Expected snapshot");
  assert.equal(raced.snapshot.activeOperationId, operationId);
  assert.equal(raced.snapshot.operationId, undefined);
  assert.equal(raced.snapshot.workFinished, false);
  assert.deepEqual(state.mutations, []);
});

test("read-only re-entry preserves failed/cancelled/timeout and Agent Markdown outcomes", async () => {
  for (const result of [
    { ok: false, code: "PROVIDER_EXECUTION_ERROR" },
    { ok: true, value: { exitCode: 0, signal: "SIGKILL", stopReason: "cancelled", stdout: "partial", stderr: "", truncated: false } },
    { ok: true, value: { exitCode: null, signal: "SIGKILL", stopReason: "timeout", stdout: "partial", stderr: "", truncated: true } },
    { ok: true, value: { status: "completed", finalResponse: "# Reply\n**Markdown** <script>untrusted</script>" } },
  ]) {
    const { state, call } = fixture();
    state.snapshot!.activeTaskId = operationId;
    state.records.set(operationId, { request: JSON.stringify({ kind: result.value && "finalResponse" in result.value ? "agent" : "command" }),
      runtimeId: "fixture", createdAt: 1, updatedAt: 2, result });
    const shown = await call();
    const inspected = await call("inspect_environment", { environmentId });
    assert.deepEqual(shown.structuredContent, { ...inspected.structuredContent, tool: "show_workbench" });
    assert.equal(shown.isError, undefined);
    assert.equal(readView(shown, 3).kind, "environment");
    assert.deepEqual(state.mutations, []);
  }
});

test("closed members are omitted, and any failed read prevents a partial chooser", async () => {
  const { state, call } = fixture([environmentId, otherId]);
  state.snapshot!.status = "closed";
  const view = readView(await call("list_environments"), 3);
  if (view.kind !== "list") throw new Error("Expected directory");
  assert.deepEqual(view.environments.map(e => e.environmentId), [otherId]);
  state.failure = "SNAPSHOT_READ_FAILED";
  await assert.rejects(call(), /SNAPSHOT_READ_FAILED/);
  state.failure = ""; state.snapshot = null;
  await assert.rejects(call(), { code: "RESOURCE_NOT_FOUND" });
  assert.deepEqual(state.mutations, []);
});
