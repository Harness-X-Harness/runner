import assert from "node:assert/strict";
import test from "node:test";
import { serveTaskRequest, type TaskAuthority } from "../apps/chatgpt-app/src/task-methods.ts";
import { observeEnvironmentResource, readEnvironmentResource } from "../apps/chatgpt-app/src/environment-resources.ts";
import { sseMessages } from "../experiments/mcp-tasks/sse-messages.ts";

for (const kind of ["output", "environment"] as const) test(`standard ${kind} events deliver URI only, read current state and stop on revoked authority`, { timeout: 5000 }, async () => {
  const taskId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
  const environmentId = `env_${"a".repeat(32)}`;
  const uri = kind === "output" ? `harness://tasks/${taskId}/output` : `harness://environments/${environmentId}`;
  let allowed = true;
  let snapshot = { revision: 0, text: "", truncated: false };
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const cancelled = Promise.withResolvers<void>();
  const authorize = async () => ({ githubUserId: "123", oauthScopes: allowed ? ["environments:use"] : [] });
  const environmentState = () => ({ environmentId, executor: "codex" as const, createdAt: 1, expiresAt: 1000,
    activeTaskId: null, status: snapshot.revision === 0 ? "opening" as const : "ready" as const });
  const currentState = () => kind === "output" ? snapshot : environmentState();
  const encoded = () => new TextEncoder().encode(`data: ${JSON.stringify(currentState())}\n\n`);
  const stream = () => {
    let attached: ReadableStreamDefaultController<Uint8Array>;
    return new ReadableStream<Uint8Array>({
      start(controller) { attached = controller; listeners.add(controller); controller.enqueue(encoded()); },
      cancel() { listeners.delete(attached); cancelled.resolve(); },
    });
  };
  const env = {
    ENVIRONMENT_ADMISSION: { getByName() { return { async list() { return []; } }; } },
    ENVIRONMENTS: { getByName(id: string) {
      assert.equal(id, `env_${"a".repeat(32)}`);
      return {
        async readEnvironment(owner: string) { assert.equal(owner, "123"); return environmentState(); },
        async observeEnvironment(owner: string) { assert.equal(owner, "123"); assert.equal(kind, "environment"); return stream(); },
        async readOutput(owner: string, task: string) {
          assert.equal(owner, "123"); assert.equal(task, taskId); return snapshot;
        },
        async observeOutput(owner: string, task: string) {
          assert.equal(owner, "123"); assert.equal(task, taskId);
          assert.equal(kind, "output"); return stream();
        },
      };
    } },
  };
  const unexpected = async (): Promise<never> => { throw new Error("unexpected Task call"); };
  const authority: TaskAuthority = {
    tools: unexpected, resources: unexpected, call: unexpected, handle: unexpected, observe: unexpected,
    readResource: async value => readEnvironmentResource(env, await authorize(), value),
    observeResources: async (uris, signal) => new Map(await Promise.all(uris.map(async value => [value,
      await observeEnvironmentResource(env, authorize, value, signal),
    ] as const))),
  };
  const controller = new AbortController();
  const request = (method: string, params: Record<string, unknown>) => serveTaskRequest(new Request("https://fixture/mcp", {
    method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...(typeof params.uri === "string" ? { "mcp-name": params.uri } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "resource-fixture", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  }), authority);
  const events = sseMessages(await request("subscriptions/listen", { notifications: { resourceSubscriptions: [uri] } }));
  try {
    assert.deepEqual((await events.next()).value, { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": 1 }, notifications: { resourceSubscriptions: [uri] } } });
    const first = (await events.next()).value;
    const expected = { jsonrpc: "2.0", method: "notifications/resources/updated",
      params: { uri, _meta: { "io.modelcontextprotocol/subscriptionId": 1 } } };
    assert.deepEqual(first, expected);
    snapshot = { revision: 1, text: "OWNER_OUTPUT", truncated: false };
    for (const listener of listeners) listener.enqueue(encoded());
    assert.deepEqual((await events.next()).value, expected);
    const result = await (await request("resources/read", { uri })).json() as { result: { contents: Array<{ text: string }> } };
    assert.deepEqual(JSON.parse(result.result.contents[0]!.text), currentState());
    allowed = false;
    for (const listener of listeners) listener.enqueue(encoded());
    const rejected = (await events.next()).value as { error: { code: number } };
    assert.equal(rejected.error.code, -32603);
    await cancelled.promise;
    assert.equal(listeners.size, 0);
    assert.equal((await request("subscriptions/listen", { notifications: { resourceSubscriptions: [uri] } })).status, 403);
  } finally { controller.abort(); await events.return(undefined); }
});
