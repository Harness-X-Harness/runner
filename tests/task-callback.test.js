import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "../apps/chatgpt-app/node_modules/jose/dist/webapi/index.js";
import { internalTaskFetch } from "../apps/chatgpt-app/src/task-callback.js";
import { taskErrorResponse } from "../apps/chatgpt-app/src/task-request.js";
import { TaskStore } from "../apps/chatgpt-app/src/task-state.js";
import { TASK_LIMITS, newTaskId } from "../shared/task-contract.js";
import { taskStorage } from "./helpers/task-storage.js";

const key = await generateKeyPair("RS256");
const wrongKey = await generateKeyPair("RS256");
const origin = "https://runner.example";
const ownerId = "123";
const repo = "example/runner";
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: "https://token.actions.githubusercontent.com", aud: origin,
  iat: now, nbf: now - 5, exp: now + 300, actor_id: ownerId,
  repository: repo, workflow_ref: `${repo}/.github/workflows/run-task.yml@refs/heads/main`,
  ref: "refs/heads/main", ref_protected: "true", event_name: "workflow_dispatch",
  runner_environment: "github-hosted", run_id: "500", run_attempt: "1",
};
const final = { status: "completed", result: { finalResponse: "PRIVATE_FINAL" } };

async function fixture() {
  const storage = taskStorage();
  const store = new TaskStore(storage);
  const taskId = newTaskId();
  await store.create({ taskId, ownerId, executor: "codex", prompt: "PRIVATE_PROMPT", repository: repo });
  const calls = [];
  const env = {
    TASK_CONTROL_PLANE_URL: origin, GITHUB_RUNNER_REPOSITORY: repo, GITHUB_RUNNER_REF: "main",
    TASKS: {
      idFromName: (id) => id,
      get(id) {
        assert.equal(id, taskId);
        return {
          async fetch(url, options) {
            const operation = new URL(url).pathname;
            calls.push(operation);
            const input = JSON.parse(options.body);
            try {
              const value = operation === "/claim" ? await store.claim(input)
                : await store.finish(input.execution, input.finish);
              return Response.json(value);
            } catch (error) { return taskErrorResponse(error); }
          },
        };
      },
    },
  };
  async function call(operation, input = {}, overrides = {}, signingKey = key.privateKey) {
    const token = await new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: "RS256" }).sign(signingKey);
    return internalTaskFetch(new Request(`${origin}/internal/tasks/${taskId}/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }), env, key.publicKey);
  }
  return { env, taskId, store, storage, calls, call };
}

test("Task callback verifies signed GitHub identity before any storage call", async () => {
  const { call, calls } = await fixture();
  const invalid = [
    { iss: "https://impostor.example" }, { aud: `${origin}/mcp` }, { exp: now - 10 },
    { exp: undefined }, { nbf: now + 300 }, { repository: "other/runner" },
    { workflow_ref: `${repo}/.github/workflows/other.yml@refs/heads/main` },
    { workflow_ref: `${repo}/.github/workflows/run-task.yml@refs/heads/topic` },
    { ref: "refs/heads/topic" }, { ref_protected: "false" }, { ref_protected: undefined },
    { run_id: "" }, { run_id: "0" }, { run_attempt: "-1" }, { actor_id: "" },
    { event_name: "pull_request" }, { runner_environment: "self-hosted" },
  ];
  for (const change of invalid) {
    const response = await call("claim", {}, change);
    assert.equal(response.status, 401, JSON.stringify(change));
    assert.equal((await response.json()).error.code, "CLAIM_REJECTED");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await call("claim", {}, {}, wrongKey.privateKey)).status, 401);
  assert.deepEqual(calls, []);
});

test("Task claim binds signed owner and exact run; request body cannot supply authority", async () => {
  const { call, store } = await fixture();
  assert.equal((await call("claim", { ownerId }, { actor_id: "456" })).status, 409);
  assert.equal((await call("finish", final)).status, 409, "finish cannot precede claim");
  const response = await call("claim", { ownerId: "999", runId: "999" });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ["executor", "prompt", "taskId"]);
  assert.equal(payload.prompt, "PRIVATE_PROMPT");
  assert.deepEqual(await (await call("claim")).json(), payload);
  for (const change of [{ run_id: "501" }, { run_attempt: "2" }, { actor_id: "456" }]) {
    assert.equal((await call("claim", {}, change)).status, 409);
    assert.equal((await call("finish", final, change)).status, 409);
  }
  assert.equal((await store.read(ownerId)).status, "running");
});

test("callback cancellation and exact finish replay preserve domain terminal gates", async () => {
  const before = await fixture();
  await before.store.cancel(ownerId);
  const denied = await before.call("claim");
  assert.equal(denied.status, 409);
  assert.equal((await denied.text()).includes("PRIVATE_PROMPT"), false);
  const active = await fixture();
  await active.call("claim");
  await active.store.cancel(ownerId);
  assert.equal((await active.call("claim")).status, 409);
  assert.deepEqual(await (await active.call("finish", final)).json(), { status: "completed" });
  assert.deepEqual(await (await active.call("finish", final)).json(), { status: "completed" });
  assert.equal((await active.call("finish", { status: "failed", error: { code: "INTERNAL_ERROR" } })).status, 409);
  assert.equal((await active.call("claim")).status, 409);
  assert.equal((await active.storage.get("task")).prompt, undefined);
});

test("callback reuses shared bounds, strips raw errors and emits no private logs", async (t) => {
  const logs = [];
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (...args) => logs.push(args));
  const { call, store } = await fixture();
  await call("claim");
  assert.equal((await call("finish", { status: "completed", result: { finalResponse: " " } })).status, 400);
  assert.equal((await call("finish", { padding: "x".repeat(TASK_LIMITS.callbackBytes) })).status, 400);
  const response = await call("finish", { status: "failed", error: {
    code: "PROVIDER_EXECUTION_ERROR", message: "PRIVATE_RAW_ERROR", stack: "PRIVATE_STACK", token: "PRIVATE_TOKEN",
  } });
  assert.deepEqual(await response.json(), { status: "failed" });
  const snapshot = JSON.stringify(await store.read(ownerId));
  assert.doesNotMatch(snapshot, /PRIVATE_|stack|token|prompt/);
  assert.deepEqual(logs, []);
  const large = await fixture();
  await large.call("claim");
  assert.equal((await large.call("finish", { status: "completed", result: {
    finalResponse: "文".repeat(TASK_LIMITS.resultBytes),
  } })).status, 200);
  const result = (await large.store.read(ownerId)).result;
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.finalResponse) <= TASK_LIMITS.resultBytes);
});

test("unknown routes, URL credentials, missing headers and malformed JSON are safe", async () => {
  const { env, taskId, calls } = await fixture();
  for (const [path, method] of [
    [`/internal/tasks/${taskId}/claim?token=PRIVATE_TOKEN`, "POST"],
    ["/internal/tasks/invalid/claim", "POST"], [`/internal/tasks/${taskId}/claim`, "GET"],
  ]) {
    const response = await internalTaskFetch(new Request(origin + path, { method }), env, key.publicKey);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /PRIVATE_TOKEN/);
  }
  const missing = await internalTaskFetch(new Request(`${origin}/internal/tasks/${taskId}/claim`, { method: "POST" }), env, key.publicKey);
  assert.equal(missing.status, 401);
  assert.deepEqual(calls, []);
  const token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).sign(key.privateKey);
  const malformed = await internalTaskFetch(new Request(`${origin}/internal/tasks/${taskId}/finish`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "PRIVATE_INVALID_JSON",
  }), env, key.publicKey);
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /PRIVATE_INVALID_JSON/);
  assert.deepEqual(calls, []);
});
