import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpRequest } from "../apps/chatgpt-app/src/mcp.ts";
import { TaskStore } from "../apps/chatgpt-app/src/task-state.ts";
import { taskErrorResponse } from "../apps/chatgpt-app/src/task-request.ts";
import { cancelTask, runTask, waitTask } from "../apps/chatgpt-app/src/task.ts";
import { taskStorage } from "./helpers/task-storage.ts";
import type { TaskEnv, RunTaskInput } from "../apps/chatgpt-app/src/task.ts";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";

function requiredStore(stores: Map<string, TaskStore>, id: string): TaskStore {
  const store = stores.get(id);
  assert.ok(store, "expected an admitted Task store");
  return store;
}

const repository = "example/runner";
const props = { githubUserId: "123", oauthScopes: ["tasks:manage"],
  githubAuthorizationKind: "github_app_scoped", environmentGithubAccessToken: "PRIVATE_USER_TOKEN" };
const execution = { ownerId: "123", repository, runId: "700", runAttempt: "1" };

function harness() {
  const stores = new Map<string, TaskStore>();
  const env = { GITHUB_RUNNER_REPOSITORY: repository, GITHUB_RUNNER_REF: "main",
    TASK_CONTROL_PLANE_URL: "https://runner.example",
    TASKS: { idFromName: (id: string) => id, get(id: string) {
      if (!stores.has(id)) stores.set(id, new TaskStore(taskStorage()));
      const store = stores.get(id);
      assert.ok(store);
      return { async fetch(url: string | URL | Request, options?: RequestInit) {
        const request = new Request(url, options);
        const input = await request.json();
        try {
          let result;
          switch (new URL(request.url).pathname) {
            case "/create": result = await store.create(input); break;
            case "/read": result = await store.read(input.ownerId); break;
            case "/control": result = await store.control(input.ownerId); break;
            case "/wait": result = await store.wait(input.ownerId, input.timeoutSeconds, input.observedStatus); break;
            case "/cancel": result = await store.cancel(input.ownerId); break;
            case "/dispatch-failed": result = await store.dispatchFailed(input.ownerId); break;
            case "/execution-ended": result = await store.executionEnded(input.ownerId, input.execution, input.conclusion); break;
            default: assert.fail("unexpected domain request");
          }
          return Response.json(result);
        } catch (error) { return taskErrorResponse(error); }
      } };
    } } as unknown as TaskEnv["TASKS"],
  };
  return { env, stores };
}

const input: RunTaskInput = { executor: "codex", prompt: "PRIVATE_PROMPT" };
const accepted = async () => new Response(null, { status: 204 });
const nativeFinal = { status: "completed", result: { finalResponse: "FINAL_RESULT" } };
function runEvidence(status = "in_progress", conclusion: string | null = null, changes: Record<string, unknown> = {}) {
  return Response.json({ id: 700, run_attempt: 1, repository: { full_name: repository },
    path: ".github/workflows/run-task.yml", actor: { id: 123 }, status, conclusion, ...changes });
}

async function mcp(env: TaskEnv, grant: Record<string, unknown>, method: string, params: { name?: string; arguments?: unknown }) {
  const response = await handleMcpRequest(new Request("https://runner.example/mcp", {
    method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28",
      "mcp-method": method, ...(params.name && { "mcp-name": params.name }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "task-test", version: "1" },
    } } }),
  }), env, grant, {
    props: grant, exports: {},
    get tracing(): never { return assert.fail("unexpected tracing access"); },
    waitUntil: () => assert.fail("unexpected background work"),
    passThroughOnException: () => assert.fail("unexpected pass-through"),
  });
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body;
}

test("MCP discovery adds three Task tools with one scope and no widget or legacy Task inputs", async () => {
  const { env } = harness();
  const listed = await mcp(env, props, "tools/list", {});
  const tools = z.array(z.looseObject({
    name: z.string(), securitySchemes: z.unknown(), _meta: z.record(z.string(), z.unknown()),
    inputSchema: z.looseObject({ required: z.array(z.string()).optional() }),
    annotations: z.record(z.string(), z.unknown()),
  })).parse(listed.result.tools).filter((x) => ["run_task", "wait_task", "cancel_task"].includes(x.name));
  assert.equal(tools.length, 3);
  for (const tool of tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["tasks:manage"] }]);
    assert.equal(tool._meta.ui, undefined);
    assert.equal(tool._meta["openai/outputTemplate"], undefined);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /repo|mode|branch|token|session/);
  }
  const run = tools.find((x) => x.name === "run_task");
  assert.ok(run);
  assert.deepEqual(run.inputSchema.required, ["executor", "prompt"]);
  assert.deepEqual(run.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  const wait = tools.find((x) => x.name === "wait_task");
  const cancel = tools.find((x) => x.name === "cancel_task");
  assert.ok(wait && cancel);
  assert.equal(wait.annotations.readOnlyHint, true);
  assert.equal(cancel.annotations.destructiveHint, true);
  assert.equal(listed.result.tools.length, 3);
});

test("MCP old scopes and absent execution authority cannot run a Task", async () => {
  const { env, stores } = harness();
  for (const grant of [
    { ...props, oauthScopes: ["sessions:manage", "environments:manage"] },
    { ...props, githubAuthorizationKind: "legacy" },
    { ...props, environmentGithubAccessToken: undefined },
    { ...props, environmentGithubAccessTokenExpiresAt: 1 },
  ]) {
    const response = await mcp(env, grant, "tools/call", { name: "run_task", arguments: input });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error.code, "TASK_AUTH_REQUIRED");
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_/);
  }
  assert.equal(stores.size, 0);
});

test("run_task dispatches only task_id once for accepted, rejected, ambiguous and lost replies", async () => {
  for (const outcome of [204, 401, 403, 422, 503, 408, "lost"]) {
    const { env, stores } = harness();
    const calls: Request[] = [];
    const task = await runTask(env, props, input, async (url, options) => {
      calls.push(new Request(url, options));
      if (typeof outcome === "string") throw new Error("PRIVATE_UPSTREAM_FAILURE");
      return new Response(null, { status: outcome });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.github.com/repos/${repository}/actions/workflows/run-task.yml/dispatches`);
    assert.deepEqual(await calls[0].json(), { ref: "main", inputs: { task_id: task.taskId } });
    assert.equal(calls[0].headers.get("authorization"), "Bearer PRIVATE_USER_TOKEN");
    assert.equal(stores.size, 1);
    assert.equal(task.status, typeof outcome === "number" && [401, 403, 422].includes(outcome) ? "failed" : "queued");
    if (task.status === "failed") {
      assert.ok(task.error);
      assert.equal(task.error.code, "DISPATCH_FAILED");
    }
    assert.doesNotMatch(JSON.stringify(task), /PRIVATE_|ownerId|prompt|execution/);
    await waitTask(env, props, { taskId: task.taskId, timeoutSeconds: 0 });
    assert.equal(calls.length, 1);
  }
});

test("an early claim survives a later ambiguous dispatch response", async () => {
  const { env, stores } = harness();
  const task = await runTask(env, props, input, async (url, options) => {
    const id = (await new Request(url, options).json()).inputs.task_id;
    await requiredStore(stores, id).claim(execution);
    throw new Error("PRIVATE_LOST_REPLY");
  });
  assert.equal(task.status, "running");
  assert.equal(task.runUrl, `https://github.com/${repository}/actions/runs/700`);
});

test("Task owner isolation applies to wait and cancellation before GitHub I/O", async () => {
  const { env } = harness();
  const task = await runTask(env, props, input, accepted);
  const foreign = { ...props, githubUserId: "456" };
  const noFetch = () => assert.fail("foreign owner must not contact GitHub");
  await assert.rejects(waitTask(env, foreign, { taskId: task.taskId }, noFetch), { code: "TASK_NOT_FOUND" });
  await assert.rejects(cancelTask(env, foreign, { taskId: task.taskId }, noFetch), { code: "TASK_NOT_FOUND" });
  await assert.rejects(waitTask(env, props, { taskId: task.taskId, timeoutSeconds: 26 }, noFetch), { code: "INVALID_TASK_INPUT" });
});

test("cancellation commits intent before exact-run HTTP and preserves uncertain stop", async () => {
  const { env, stores } = harness();
  const task = await runTask(env, props, input, accepted);
  const store = requiredStore(stores, task.taskId);
  await store.claim(execution);
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (url, options) => {
    assert.equal((await store.read("123")).status, "cancelling");
    calls.push(new Request(url, options));
    if (String(url).endsWith("/attempts/1")) return runEvidence();
    return new Response(null, { status: 202 });
  };
  assert.equal((await cancelTask(env, props, { taskId: task.taskId }, fetchImpl)).status, "cancelling");
  assert.deepEqual(calls.map((x) => x.url), [
    `https://api.github.com/repos/${repository}/actions/runs/700/attempts/1`,
    `https://api.github.com/repos/${repository}/actions/runs/700/cancel`,
  ]);
  await assert.rejects(cancelTask(env, props, { taskId: task.taskId }, async (url) => {
    if (String(url).endsWith("/attempts/1")) return runEvidence();
    throw new Error("PRIVATE_CANCEL_ERROR");
  }), { code: "GITHUB_UNAVAILABLE" });
  assert.equal((await store.read("123")).status, "cancelling");
  await store.finish(execution, nativeFinal);
  const noFetch = () => assert.fail("terminal Task must not repeat cancellation");
  assert.equal((await cancelTask(env, props, { taskId: task.taskId }, noFetch)).status, "completed");
});

test("pre-claim cancellation denies a late run without looking up a guessed run", async () => {
  const { env, stores } = harness();
  const task = await runTask(env, props, input, accepted);
  assert.equal((await cancelTask(env, props, { taskId: task.taskId }, () => assert.fail("no bound run"))).status, "cancelling");
  await assert.rejects(requiredStore(stores, task.taskId).claim(execution), { code: "CLAIM_REJECTED" });
});

test("authorized observation reconciles a lost finish only from exact terminal evidence", async () => {
  for (const conclusion of ["success", "failure", "cancelled", "timed_out"]) {
    const { env, stores } = harness();
    const task = await runTask(env, props, input, accepted);
    await requiredStore(stores, task.taskId).claim(execution);
    const observed = await waitTask(env, props, { taskId: task.taskId, timeoutSeconds: 0.1 }, async (url) => {
      assert.equal(url, `https://api.github.com/repos/${repository}/actions/runs/700/attempts/1`);
      return runEvidence("completed", conclusion);
    });
    assert.equal(observed.status, conclusion === "cancelled" ? "cancelled" : "failed");
    assert.ok(observed.error);
    assert.equal(observed.error.code, conclusion === "cancelled" ? "CANCELLED" :
      conclusion === "timed_out" ? "TASK_TIMEOUT" : "EXECUTION_ENDED");
    assert.equal(observed.result, undefined);
    await assert.rejects(requiredStore(stores, task.taskId).finish(execution, nativeFinal), { code: "CLAIM_REJECTED" });
    assert.deepEqual(await waitTask(env, props, { taskId: task.taskId }, () => assert.fail("terminal")), observed);
  }
});

test("active, missing, revoked, wrong-attempt and unavailable observations cannot invent termination", async () => {
  const { env, stores } = harness();
  const task = await runTask(env, props, input, accepted);
  await requiredStore(stores, task.taskId).claim(execution);
  assert.equal((await waitTask(env, props, { taskId: task.taskId, timeoutSeconds: 0.005 }, async () => runEvidence())).status, "running");
  for (const fetchImpl of [
    async () => new Response(null, { status: 503 }), async () => new Response(null, { status: 404 }),
    async () => runEvidence("completed", "success", { run_attempt: 2 }),
    async () => runEvidence("completed", "success", { id: 701 }),
    async () => runEvidence("completed", "success", { repository: { full_name: "other/runner" } }),
    async () => runEvidence("completed", "success", { actor: { id: 456 } }),
    async () => { throw new Error("PRIVATE_NETWORK_ERROR"); },
  ]) {
    await assert.rejects(waitTask(env, props, { taskId: task.taskId }, fetchImpl), { code: "GITHUB_UNAVAILABLE" });
    assert.equal((await requiredStore(stores, task.taskId).read("123")).status, "running");
  }
  await assert.rejects(waitTask(env, props, { taskId: task.taskId }, async () => new Response(null, { status: 401 })), { code: "TASK_AUTH_REQUIRED" });
  await assert.rejects(waitTask(env, { ...props, environmentGithubAccessToken: undefined }, { taskId: task.taskId }), { code: "TASK_AUTH_REQUIRED" });
  assert.equal((await requiredStore(stores, task.taskId).read("123")).status, "running");
});

test("a finish during GitHub observation wins over delayed terminal evidence", async () => {
  const { env, stores } = harness();
  const task = await runTask(env, props, input, accepted);
  const store = requiredStore(stores, task.taskId);
  await store.claim(execution);
  const result = await waitTask(env, props, { taskId: task.taskId }, async () => {
    await store.finish(execution, nativeFinal);
    return runEvidence("completed", "cancelled");
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, nativeFinal.result);
});

test("MCP returns semantic Task output and safe errors without private inputs", async (t) => {
  const { env, stores } = harness();
  t.mock.method(globalThis, "fetch", accepted);
  const started = await mcp(env, props, "tools/call", { name: "run_task", arguments: input });
  assert.equal(started.result.isError, undefined);
  const taskId = started.result.structuredContent.taskId;
  await requiredStore(stores, taskId).claim(execution);
  await requiredStore(stores, taskId).finish(execution, nativeFinal);
  const waited = await mcp(env, props, "tools/call", { name: "wait_task", arguments: { taskId } });
  assert.deepEqual(waited.result.structuredContent.result, nativeFinal.result);
  assert.doesNotMatch(JSON.stringify(waited), /PRIVATE_|ownerId|runAttempt|execution|prompt/);
});
