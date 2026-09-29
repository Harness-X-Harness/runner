import test from "node:test";
import assert from "node:assert/strict";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";
import { environmentTaskAuthority } from "../apps/chatgpt-app/src/environment-task-authority.ts";
import { serveTaskRequest } from "../apps/chatgpt-app/src/task-methods.ts";
import { lifecycleTask } from "../apps/chatgpt-app/src/environment-lifecycle-task.ts";
import type { EnvironmentSnapshot, OperationRecord } from "../apps/chatgpt-app/src/environment-object.ts";

test("ordinary clients receive one honest contract and Tasks clients keep Task handles", async () => {
  const environmentId = `env_${"a".repeat(32)}`;
  const records = new Map<string, OperationRecord>();
  const state = { reservations: 0, opens: 0, dispatches: 0, closes: 0, answers: 0, names: [] as string[],
    reads: [] as string[], cancellations: 0,
    status: "ready" as EnvironmentSnapshot["status"], activeTaskId: null as string | null, failRead: false,
    immediateResult: undefined as OperationRecord["result"] };
  const env = { ENVIRONMENT_ADMISSION: { getByName() { return { async list() { return [environmentId]; } }; } },
    ENVIRONMENTS: { getByName(id: string) {
      state.names.push(id);
      return {
        async readEnvironment(owner: string): Promise<EnvironmentSnapshot | null> {
          if (state.failRead) throw new Error("PRIVATE_STORAGE_FAILURE");
          if (owner !== "123") return null;
          return { environmentId: id, executor: "codex", status: state.status, createdAt: 1, expiresAt: 1000, activeTaskId: state.activeTaskId,
            agent: { state: { defaults: { model: "fixture", reasoningEffort: "high" }, models: [], selection: null, uncertain: false },
              observedAt: 1, current: true } };
        },
        async initialize(value: { environmentId: string; executor: "codex" | "grok" }) {
          state.opens++;
          return { environmentId: value.environmentId, executor: value.executor, createdAt: 1 };
        },
        async dispatchExecution() { state.dispatches++; return "accepted" as const; },
        async requestClose(owner: string) {
          if (owner !== "123") return null;
          return state.status === "closed" ? "closed" as const : "closing" as const;
        },
        async closeExecution() { state.closes++; return "closing" as const; },
        async readLifecycleTask(owner: string, kind: "open" | "close") {
          return owner === "123" ? lifecycleTask(id, kind, { createdAt: 1, updatedAt: 2,
            status: state.status === "closed" ? "completed" : "working" }) : null;
        },
        async reserveOperation(_owner: string, taskId: string, request: string) {
          state.reservations++;
          const record = records.get(taskId) ?? { request, runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 1 };
          if (state.immediateResult !== undefined) record.result = state.immediateResult;
          records.set(taskId, record);
          state.activeTaskId = taskId;
          return record;
        },
        async readOperation(owner: string, taskId: string) {
          state.reads.push(taskId);
          return owner === "123" ? records.get(taskId) ?? null : null;
        },
        async readOutput(owner: string) { return owner === "123" ? { revision: 1, text: "PROGRESS", truncated: false } : null; },
        async answerOperation(owner: string, taskId: string, responses: unknown) {
          assert.equal(owner, "123");
          assert.ok(records.has(taskId));
          assert.deepEqual(responses, { ask: { action: "accept", content: { name: "chosen" } } });
          state.answers++;
        },
        async cancelOperation(owner: string, taskId: string) {
          assert.equal(owner, "123");
          const record = records.get(taskId);
          assert.ok(record);
          record.cancelRequested = true;
          state.cancellations++;
        },
        async cancelLifecycleTask() { throw new Error("unexpected lifecycle cancel"); },
        async observeLifecycleTask() { throw new Error("unexpected lifecycle stream"); },
        async observeOperation() { throw new Error("unexpected stream"); },
        async observeOutput() { throw new Error("unexpected output stream"); },
        async observeEnvironment() { throw new Error("unexpected environment stream"); },
      };
    } } };
  const authority = environmentTaskAuthority(env, async () => ({ githubUserId: "123",
    githubAuthorizationKind: "github_app_scoped", environmentGithubAccessToken: "fixture-token",
    oauthScopes: ["environments:use"] }));
  const other = environmentTaskAuthority(env, async () => ({ githubUserId: "456",
    githubAuthorizationKind: "github_app_scoped", environmentGithubAccessToken: "fixture-token",
    oauthScopes: ["environments:use"] }));
  const rpc = async (method: string, params: Record<string, unknown>, capable = false, caller = authority) => {
    const name = params.name ?? params.taskId ?? params.uri;
    const request = new Request("https://fixture/mcp", { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": capable ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {},
    } } }) });
    return z.object({ error: z.object({ code: z.number(), message: z.string() }).optional(),
      result: z.looseObject({ resultType: z.string().optional(), isError: z.boolean().optional(),
        status: z.string().optional(), taskId: z.string().optional(), structuredContent: z.unknown().optional(),
        content: z.unknown().optional() }).optional() }).parse(await (await serveTaskRequest(request, caller)).json());
  };
  const text = (response: Awaited<ReturnType<typeof rpc>>) => JSON.stringify(response.result?.content ?? "");
  const body = (response: Awaited<ReturnType<typeof rpc>>) => JSON.stringify(response);

  assert.equal(authority.ordinaryToolCalls, true);
  const catalog = await rpc("tools/list", {});
  const tools = z.array(z.looseObject({ name: z.string(), annotations: z.looseObject({ readOnlyHint: z.boolean() }) }))
    .parse(catalog.result?.tools);
  assert.ok(tools.some(tool => tool.name === "update_operation" && !tool.annotations.readOnlyHint));
  assert.deepEqual(tools.map(tool => tool.name), tools.map(tool => tool.name).sort());
  assert.equal(tools.find(tool => tool.name === "inspect_environment")?.annotations.readOnlyHint, true);

  const command = { name: "command", arguments: { environmentId, argv: ["pwd"], timeoutSeconds: 5 } };
  const accepted = await rpc("tools/call", command);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result?.resultType, "complete");
  assert.equal(accepted.result?.status, undefined);
  assert.equal(state.reservations, 1);
  const receipt = z.object({ contract: z.literal("ordinary"), workFinished: z.literal(false),
    operationStatus: z.literal("working"), operationId: z.string() }).parse(accepted.result?.structuredContent);
  assert.match(text(accepted), /Do not poll/);
  assert.doesNotMatch(body(accepted), /PRIVATE_RUNTIME|resultType":"task/);

  const handle = await rpc("tools/call", { ...command, arguments: { ...command.arguments, idempotencyKey: "tasks-client" } }, true);
  assert.equal(handle.result?.resultType, "task");
  assert.equal(handle.result?.status, "working");
  assert.doesNotMatch(body(handle), /Ordinary result/);
  assert.equal((await rpc("tasks/get", { taskId: handle.result?.taskId }, true)).result?.status, "working");
  assert.equal((await rpc("tasks/get", { taskId: handle.result?.taskId })).error?.code, -32021);
  assert.equal((await rpc("tasks/update", { taskId: handle.result?.taskId, inputResponses: {} })).error?.code, -32021);
  assert.equal(state.answers, 0);

  state.immediateResult = { ok: true, value: { exitCode: 0, signal: null, stdout: "FAST_RESULT", stderr: "", truncated: false } };
  const fast = await rpc("tools/call", { ...command, arguments: { ...command.arguments, idempotencyKey: "fast" } });
  assert.equal(fast.result?.isError, undefined);
  assert.equal(z.object({ workFinished: z.literal(true) }).parse(fast.result?.structuredContent).workFinished, true);
  assert.match(text(fast), /FAST_RESULT/);
  assert.doesNotMatch(text(fast), /Do not poll/);
  state.immediateResult = undefined;

  const ask = `task_${environmentId.slice(4)}_${"1".repeat(32)}`;
  records.set(ask, { request: JSON.stringify({ kind: "agent", prompt: "PRIVATE_PROMPT" }), runtimeId: "PRIVATE_RUNTIME",
    createdAt: 1, updatedAt: 2, inputs: { ask: { request: { method: "elicitation/create", params: { mode: "form",
      message: "Which name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } } } });
  state.activeTaskId = ask;
  const inspected = await rpc("tools/call", { name: "inspect_environment", arguments: { environmentId } }, true);
  assert.equal(inspected.result?.resultType, "complete");
  assert.ok(z.object({ agent: z.object({ state: z.object({ models: z.array(z.unknown()) }) }) })
    .parse(inspected.result?.structuredContent).agent);
  assert.equal(z.object({ disposition: z.literal("waiting_for_input"), questions: z.array(z.object({ message: z.string() })) })
    .parse(inspected.result?.structuredContent).questions[0]?.message, "Which name?");
  assert.match(text(inspected), /not success/);
  assert.doesNotMatch(body(inspected), /PRIVATE_PROMPT|PRIVATE_RUNTIME/);
  const inputView = z.object({ expiresAt: z.literal(1000), output: z.object({ text: z.literal("PROGRESS") }),
    questions: z.array(z.object({ operationId: z.literal(ask), requestedSchema: z.object({ type: z.literal("object") }) })) })
    .parse(inspected.result?.structuredContent);
  assert.equal(inputView.questions.length, 1);

  const oldId = `task_${environmentId.slice(4)}_${"2".repeat(32)}`;
  records.set(oldId, { request: JSON.stringify({ kind: "command" }), runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 3,
    result: { ok: true, value: { exitCode: 0, signal: null, stdout: "OLD_RESULT", stderr: "", truncated: false } } });
  state.reads = [];
  const historical = await rpc("tools/call", { name: "inspect_environment", arguments: { environmentId, operationId: oldId } });
  assert.deepEqual(state.reads, [oldId, ask]);
  const historicalReceipt = z.object({ historical: z.literal(true), operationId: z.literal(oldId),
    operationStatus: z.literal("completed"), activeOperationId: z.literal(ask),
    activeOperationStatus: z.literal("input_required"), workFinished: z.literal(false),
    questions: z.array(z.object({ message: z.string() })) }).parse(historical.result?.structuredContent);
  assert.equal(historicalReceipt.questions[0]?.message, "Which name?");
  assert.match(text(historical), /OLD_RESULT/);
  assert.match(text(historical), /Which name\?/);
  assert.match(text(historical), /not success/);
  assert.match(text(historical), /not the active operation/);
  assert.doesNotMatch(body(historical), /PRIVATE_SCHEMA|PRIVATE_PROMPT|PRIVATE_RUNTIME/);
  state.reads = [];
  const same = await rpc("tools/call", { name: "inspect_environment", arguments: { environmentId, operationId: ask } });
  assert.deepEqual(state.reads, [ask]);
  assert.equal(z.object({ operationId: z.literal(ask), activeOperationStatus: z.literal("input_required"),
    historical: z.boolean().optional() }).parse(same.result?.structuredContent).historical, undefined);

  const beforeNames = state.names.length;
  const mismatched = await rpc("tools/call", { name: "inspect_environment", arguments: { environmentId,
    operationId: `task_${"b".repeat(32)}_${"c".repeat(32)}` } });
  assert.equal(mismatched.result?.isError, true);
  assert.match(text(mismatched), /operationId/);
  assert.equal(state.names.length, beforeNames);
  const absent = await rpc("tools/call", { name: "inspect_environment", arguments: { environmentId } }, false, other);
  assert.equal(absent.result?.isError, true);
  assert.match(text(absent), /not found or no longer available/);
  assert.doesNotMatch(body(absent), /PRIVATE_PROMPT|OLD_RESULT/);

  const answer = { name: "update_operation", arguments: { operationId: ask, action: "answer",
    inputResponses: { ask: { action: "accept", content: { name: "chosen" } } } } };
  const answered = await rpc("tools/call", answer);
  assert.equal(answered.error, undefined);
  assert.deepEqual(z.object({ tool: z.literal("update_operation"), agent: z.undefined().optional() })
    .parse(answered.result?.structuredContent), { tool: "update_operation" });
  assert.equal(state.answers, 1);
  assert.equal(state.reservations, 3);
  for (const arguments_ of [
    { operationId: ask, action: "answer" },
    { operationId: ask, action: "cancel", inputResponses: {} },
    { operationId: `task_${environmentId.slice(4)}_close`, action: "cancel" },
  ]) assert.equal((await rpc("tools/call", { name: "update_operation", arguments: arguments_ })).result?.isError, true);
  assert.equal(state.cancellations, 0);
  const cancelled = await rpc("tools/call", { name: "update_operation", arguments: { operationId: ask, action: "cancel" } });
  assert.equal(state.cancellations, 1);
  assert.equal(state.closes, 0);
  assert.equal(z.object({ operationStatus: z.literal("working"), workFinished: z.literal(false) })
    .parse(cancelled.result?.structuredContent).workFinished, false);

  state.status = "opening";
  state.activeTaskId = null;
  const opened = await rpc("tools/call", { name: "open_environment", arguments: { executor: "codex", idempotencyKey: "ordinary-open" } });
  assert.equal(state.opens, 1);
  assert.equal(state.dispatches, 1);
  assert.equal(opened.result?.resultType, "complete");
  const openReceipt = z.object({ environmentId: z.string(), environmentStatus: z.literal("opening"), workFinished: z.literal(false) })
    .parse(opened.result?.structuredContent);
  assert.equal(openReceipt.environmentId.startsWith("env_"), true);
  assert.match(text(opened), /is opening/);
  assert.doesNotMatch(text(opened), /is ready/);
  const tasked = await rpc("tools/call", { name: "open_environment", arguments: { executor: "codex", idempotencyKey: "task-open" } }, true);
  assert.equal(tasked.result?.resultType, "task");
  assert.doesNotMatch(body(tasked), /Ordinary result/);

  state.status = "closing";
  const closing = await rpc("tools/call", { name: "close_environment", arguments: { environmentId: openReceipt.environmentId } });
  assert.equal(state.closes, 1);
  assert.equal(z.object({ workFinished: z.literal(false) }).parse(closing.result?.structuredContent).workFinished, false);
  assert.match(text(closing), /closing is not closed/);
  state.status = "closed";
  const closed = await rpc("tools/call", { name: "close_environment", arguments: { environmentId: openReceipt.environmentId } });
  assert.equal(state.closes, 1);
  assert.equal(z.object({ workFinished: z.literal(true) }).parse(closed.result?.structuredContent).workFinished, true);
  assert.match(text(closed), /closed confirms capacity release/);
  assert.doesNotMatch(text(closed), /Do not poll/);

  state.failRead = true;
  state.status = "ready";
  const broken = await rpc("tools/call", { ...command, arguments: { ...command.arguments, idempotencyKey: "broken-read" } });
  assert.equal(broken.error?.code, -32603);
  assert.equal(broken.result, undefined);
  assert.doesNotMatch(body(broken), /PRIVATE_STORAGE_FAILURE|Ordinary result/);
});
