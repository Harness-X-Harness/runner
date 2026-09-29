import test from "node:test";
import assert from "node:assert/strict";
import { environmentTaskAuthority } from "../apps/chatgpt-app/src/environment-task-authority.ts";
import { serveTaskRequest } from "../apps/chatgpt-app/src/task-methods.ts";
import type { EnvironmentSnapshot, OperationRecord } from "../apps/chatgpt-app/src/environment-object.ts";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";
import { lifecycleTask } from "../apps/chatgpt-app/src/environment-lifecycle-task.ts";

test("standard HTTP Task calls reach the Environment authority without exposing operation internals", async () => {
  const environmentId = `env_${"a".repeat(32)}`;
  const records = new Map<string, OperationRecord>();
  let permits = true;
  let reservations = 0;
  let immediateResult: OperationRecord["result"];
  let lifecycle: EnvironmentSnapshot["status"] = "ready";
  let readFailure = false;
  let closeExecutions = 0;
  const env = { ENVIRONMENT_ADMISSION: { getByName(name: string) {
    assert.equal(name, "global");
    return { async list(owner: string) { return owner === "123" ? [environmentId] : []; } };
  } }, ENVIRONMENTS: { getByName(id: string) {
    assert.equal(id, environmentId);
    return {
      async readEnvironment(owner: string): Promise<EnvironmentSnapshot | null> {
        if (readFailure) throw new Error("PRIVATE_STORAGE_FAILURE");
        if (owner !== "123") return null;
        return { environmentId, executor: "codex", status: lifecycle, createdAt: 1, expiresAt: 1000, activeTaskId: null };
      },
      async readOutput(owner: string, taskId: string) {
        if (readFailure) throw new Error("PRIVATE_STORAGE_FAILURE");
        if (owner !== "123" || !records.has(taskId)) return null;
        return { revision: 2, text: "OWNER_VISIBLE", truncated: false };
      },
      async initialize(): Promise<never> { throw new Error("unexpected open"); },
      async dispatchExecution(): Promise<never> { throw new Error("unexpected dispatch"); },
      async requestClose(owner: string): Promise<"closing" | "closed" | null> {
        if (readFailure) throw new Error("PRIVATE_STORAGE_FAILURE");
        if (owner !== "123") return null;
        return lifecycle === "closed" ? "closed" : "closing";
      },
      async closeExecution(): Promise<"closing"> { closeExecutions++; return "closing"; },
      async readLifecycleTask(owner: string, kind: "open" | "close") {
        return owner === "123" ? lifecycleTask(environmentId, kind,
          { createdAt: 1, updatedAt: 2, status: lifecycle === "closed" ? "completed" : "working" }) : null;
      },
      async cancelLifecycleTask(): Promise<never> { throw new Error("unexpected lifecycle cancel"); },
      async observeLifecycleTask(): Promise<never> { throw new Error("unexpected lifecycle stream"); },
      async observeOperation(): Promise<never> { throw new Error("unexpected stream"); },
      async observeOutput(): Promise<never> { throw new Error("unexpected output stream"); },
      async observeEnvironment(): Promise<never> { throw new Error("unexpected environment stream"); },
      async answerOperation(): Promise<never> { throw new Error("unexpected answer"); },
      async reserveOperation(owner: string, taskId: string, request: string) {
        assert.equal(owner, "123"); reservations++;
        const record = records.get(taskId) ?? { request, runtimeId: "PRIVATE_RUNTIME", createdAt: 1, updatedAt: 1 };
        if (immediateResult !== undefined) record.result = immediateResult;
        records.set(taskId, record); return record;
      },
      async readOperation(owner: string, taskId: string) {
        if (readFailure) throw new Error("PRIVATE_STORAGE_FAILURE");
        return owner === "123" ? records.get(taskId) ?? null : null;
      },
      async cancelOperation(owner: string, taskId: string) {
        assert.equal(owner, "123"); records.get(taskId)!.cancelRequested = true;
      },
    };
  } } };
  const authority = environmentTaskAuthority(env, async () => ({ githubUserId: "123",
    githubAuthorizationKind: "github_app_scoped", environmentGithubAccessToken: "fixture-token",
    oauthScopes: permits ? ["environments:use"] : [] }));
  const rpc = async (method: string, params: Record<string, unknown>, capable = true, caller = authority) => {
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
    return z.object({ error: z.unknown().optional(), result: z.looseObject({
      taskId: z.string().optional(), resultType: z.string().optional(), status: z.string().optional(),
    }).optional() }).parse(await (await serveTaskRequest(request, caller)).json());
  };
  const params = { name: "command", arguments: { environmentId, argv: ["pwd"], timeoutSeconds: 5 } };
  const discovered = await rpc("server/discover", {}, false);
  assert.equal(discovered.result?.ttlMs, 0);
  assert.equal(discovered.result?.cacheScope, "private");
  assert.deepEqual(discovered.result?.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discovered.result?.capabilities, { tools: {}, resources: { subscribe: true },
    extensions: { "io.modelcontextprotocol/tasks": {} } });
  assert.equal((await rpc("ping", {}, false)).result?.resultType, "complete");
  assert.equal(reservations, 0);
  const catalog = await rpc("tools/list", {}, false);
  assert.equal(catalog.result?.ttlMs, 0);
  assert.equal(catalog.result?.cacheScope, "private");
  const tools = z.array(z.looseObject({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) })).parse(catalog.result?.tools);
  assert.ok(tools.some(tool => tool.name === "update_operation"));
  assert.deepEqual(tools.map(tool => tool.name), tools.map(tool => tool.name).sort());
  assert.equal(reservations, 0);
  assert.ok(!JSON.stringify(tools).includes('"kind"'));
  const command = tools.find(tool => tool.name === "command")!;
  const commandSchema = z.fromJSONSchema(command.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  assert.doesNotThrow(() => commandSchema.parse(params.arguments));
  assert.throws(() => commandSchema.parse({ ...params.arguments, argv: [] }));
  assert.equal((await rpc("tasks/get", { taskId: `task_${"b".repeat(32)}_${"d".repeat(32)}` }, false)).error?.code, -32021);
  assert.equal(reservations, 0);
  for (const [name, arguments_, field] of [
    ["command", { environmentId, argv: ["PRIVATE_INPUT"] }, "timeoutSeconds"],
    ["agent", { environmentId, prompt: { secret: "PRIVATE_INPUT" } }, "prompt"],
    ["open_environment", { executor: "PRIVATE_INPUT" }, "executor"],
    ["close_environment", { environmentId: "PRIVATE_INPUT" }, "environmentId"],
  ] as const) {
    const invalid = await rpc("tools/call", { name, arguments: arguments_ });
    assert.equal(invalid.error, undefined);
    assert.equal(invalid.result?.resultType, "complete");
    assert.equal(invalid.result?.isError, true);
    assert.match(JSON.stringify(invalid.result?.content), new RegExp(field));
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_INPUT/);
    assert.equal(reservations, 0);
  }
  const created = await rpc("tools/call", params);
  const taskId = created.result?.taskId;
  assert.equal(typeof taskId, "string");
  if (!taskId) throw new Error("Task ID missing");
  assert.equal(created.result?.resultType, "task");
  assert.equal(created.result?.status, "working");
  assert.ok(!JSON.stringify(created).includes("PRIVATE_RUNTIME"));
  assert.equal((await rpc("tasks/get", { taskId })).result?.status, "working");
  // A completion committed before the first snapshot is a tool result, not a Task handle.
  for (const exitCode of [0, 7]) {
    const value = { exitCode, signal: null, stdout: "FAST_RESULT", stderr: "", truncated: false };
    immediateResult = { ok: true, value };
    const fast = await rpc("tools/call", { ...params, arguments: { ...params.arguments,
      idempotencyKey: `fast-result-${exitCode}` } });
    assert.equal(fast.result?.resultType, "complete");
    assert.equal(fast.result?.taskId, undefined);
    assert.equal(fast.result?.isError, exitCode !== 0);
    assert.deepEqual(fast.result?.structuredContent, value);
  }
  immediateResult = undefined;
  for (const missingId of ["malformed", `task_${"a".repeat(32)}_${"0".repeat(32)}`]) {
    assert.deepEqual((await rpc("tasks/get", { taskId: missingId })).error,
      { code: -32602, message: "Task not found or no longer available" });
  }
  readFailure = true;
  assert.deepEqual((await rpc("tasks/get", { taskId })).error, { code: -32603, message: "Task request failed" });
  readFailure = false;
  assert.equal((await rpc("tasks/cancel", { taskId })).result?.resultType, "complete");
  assert.equal(records.get(taskId)!.cancelRequested, true);
  assert.equal((await rpc("tasks/get", { taskId })).result?.status, "working");
  const uri = `harness://environments/${environmentId}`;
  const freshClient = environmentTaskAuthority(env, async () => ({ githubUserId: "123", oauthScopes: ["environments:use"] }));
  const otherOwner = environmentTaskAuthority(env, async () => ({ githubUserId: "456", oauthScopes: ["environments:use"] }));
  assert.deepEqual((await rpc("tasks/get", { taskId }, true, otherOwner)).error,
    { code: -32602, message: "Task not found or no longer available" });
  const resourceUris = (response: Awaited<ReturnType<typeof rpc>>) =>
    z.array(z.object({ uri: z.string() })).parse(response.result?.resources).map(item => item.uri);
  const resourceCatalog = await rpc("resources/list", {}, false, freshClient);
  assert.deepEqual(resourceUris(resourceCatalog), [uri]);
  assert.equal(resourceCatalog.result?.ttlMs, 0);
  assert.equal(resourceCatalog.result?.cacheScope, "private");
  assert.deepEqual(resourceUris(await rpc("resources/list", {}, false, otherOwner)), []);
  const unavailable = { code: -32602, message: "Resource not found or no longer available" };
  assert.deepEqual((await rpc("resources/read", { uri }, false, otherOwner)).error, unavailable);
  const deniedClose = await rpc("tools/call", { name: "close_environment", arguments: { environmentId } }, true, otherOwner);
  assert.equal(deniedClose.error, undefined);
  assert.equal(deniedClose.result?.resultType, "complete");
  assert.equal(deniedClose.result?.isError, true);
  assert.equal(lifecycle, "ready");
  assert.equal(closeExecutions, 0);
  assert.ok((await rpc("resources/read", { uri: `${uri}?owner=123` }, false)).error);
  assert.ok((await rpc("resources/list", { cursor: "invented" }, false)).error);
  const read = await rpc("resources/read", { uri }, false, freshClient);
  assert.equal(read.result?.ttlMs, 0);
  assert.equal(read.result?.cacheScope, "private");
  const contents = z.array(z.object({ text: z.string() })).parse(read.result?.contents);
  assert.equal(JSON.parse(contents[0]!.text).status, "ready");
  assert.ok(!JSON.stringify(read).includes("PRIVATE_RUNTIME"));
  const outputUri = `harness://tasks/${taskId}/output`;
  const output = await rpc("resources/read", { uri: outputUri }, false, freshClient);
  const outputContents = z.array(z.object({ text: z.string() })).parse(output.result?.contents);
  assert.deepEqual(JSON.parse(outputContents[0]!.text), { revision: 2, text: "OWNER_VISIBLE", truncated: false });
  assert.deepEqual((await rpc("resources/read", { uri: outputUri }, false, otherOwner)).error, unavailable);
  assert.deepEqual((await rpc("resources/read", {
    uri: `harness://tasks/task_${"a".repeat(32)}_${"0".repeat(32)}/output`,
  }, false)).error, unavailable);
  readFailure = true;
  for (const [method, arguments_] of [
    ["resources/list", {}], ["resources/read", { uri }], ["resources/read", { uri: outputUri }],
    ["tools/call", { name: "close_environment", arguments: { environmentId } }],
  ] as const) {
    const failure = await rpc(method, arguments_);
    assert.deepEqual(failure.error, { code: -32603, message: "Task request failed" });
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_STORAGE_FAILURE/);
  }
  readFailure = false;
  // Close can commit between membership lookup and lifecycle read.
  lifecycle = "closing";
  const closing = await rpc("tools/call", { name: "close_environment", arguments: { environmentId } });
  assert.equal(closing.result?.resultType, "task");
  assert.equal(closing.result?.status, "working");
  assert.equal(closing.result?.taskId, `task_${environmentId.slice(4)}_close`);
  assert.equal((await rpc("tasks/get", { taskId: closing.result?.taskId })).result?.status, "working");
  assert.deepEqual((await rpc("tasks/get", { taskId: closing.result?.taskId }, true, otherOwner)).error,
    { code: -32602, message: "Task not found or no longer available" });
  lifecycle = "closed";
  assert.equal((await rpc("tasks/get", { taskId: closing.result?.taskId })).result?.status, "completed");
  assert.deepEqual(resourceUris(await rpc("resources/list", {}, false)), []);
  assert.equal((await rpc("resources/read", { uri }, false)).result?.resultType, "complete");
  const closed = await rpc("tools/call", { name: "close_environment", arguments: { environmentId } });
  const links = z.array(z.looseObject({ type: z.string(), uri: z.string().optional() })).parse(closed.result?.content);
  assert.deepEqual(links.filter(item => item.type === "resource_link").map(item => item.uri), [uri]);
  permits = false;
  assert.ok((await rpc("tasks/get", { taskId })).error);
  assert.ok((await rpc("tools/list", {}, false)).error);
  assert.ok((await rpc("resources/list", {}, false)).error);
  assert.ok((await rpc("resources/read", { uri }, false)).error);
});
