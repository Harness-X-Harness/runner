import test from "node:test";
import assert from "node:assert/strict";
import { observeMcpEventRequest } from "../apps/chatgpt-app/src/mcp-event-diagnostics.ts";
import { serveTaskRequest, type TaskAuthority } from "../apps/chatgpt-app/src/task-methods.ts";

test("protocol rejection identifies a missing-header initialize or Events method without reading or logging parameters", async t => {
  const records: unknown[] = [];
  t.mock.method(console, "log", (record: unknown) => records.push(record));
  const forbidden = async (): Promise<never> => { throw new Error("Authority must not run"); };
  const authority: TaskAuthority = { tools: forbidden, resources: forbidden, readResource: forbidden,
    call: forbidden, handle: forbidden, observe: forbidden, observeResources: forbidden,
    events: { handle: forbidden } };
  for (const method of ["initialize", "server/discover", "events/list", "events/subscribe", "events/unsubscribe", "PRIVATE"]) {
    records.length = 0;
    const request = new Request("https://fixture/mcp?code=PRIVATE", { method: "POST",
      headers: { authorization: "Bearer PRIVATE", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "PRIVATE", method, params: {
        protocolVersion: "2025-11-25", clientInfo: { name: "PRIVATE", version: "PRIVATE" },
        name: "PRIVATE", prompt: "PRIVATE", delivery: { url: "https://private-callback.example/PRIVATE", secret: "PRIVATE" },
      } }),
    });
    const response = await serveTaskRequest(request, authority);
    assert.equal(response.status, 400);
    const reply = await response.json() as { id: string; error: { code: number } };
    assert.equal(reply.error.code, -32022);
    assert.equal(reply.id, "PRIVATE");
    assert.deepEqual(records, [{ event: "mcp.protocol.rejected",
      bodyMethod: method === "PRIVATE" ? "other" : method, rpcCode: -32022 }]);
    assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
  }
});

test("valid modern requests preserve their response and emit no protocol rejection", async t => {
  const records: unknown[] = [];
  t.mock.method(console, "log", (record: unknown) => records.push(record));
  const forbidden = async (): Promise<never> => { throw new Error("Authority must not run"); };
  const authority: TaskAuthority = { tools: forbidden, resources: forbidden, readResource: forbidden,
    call: forbidden, handle: forbidden, observe: forbidden, observeResources: forbidden };
  const response = await serveTaskRequest(new Request("https://fixture/mcp", { method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "ping" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "PRIVATE", method: "ping", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "PRIVATE", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  }), authority);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: "PRIVATE", result: { resultType: "complete" } });
  assert.deepEqual(records, []);
});

test("event wire diagnostics distinguish discovery, catalog, callback rejection and missing headers without private data", async () => {
  for (const method of ["server/discover", "events/list", "events/subscribe", "events/unsubscribe", undefined]) {
    const records: unknown[] = [];
    const request = new Request("https://fixture/mcp?code=PRIVATE", { method: "POST",
      headers: { authorization: "Bearer PRIVATE", "mcp-protocol-version": "2026-07-28",
        ...(method ? { "mcp-method": method } : {}) },
      body: JSON.stringify({ prompt: "PRIVATE", delivery: { url: "https://private-callback.example/PRIVATE", secret: "PRIVATE" } }),
    });
    const response = Response.json({ error: { code: -32015, message: "PRIVATE", data: { url: "PRIVATE" } } }, { status: 400 });
    const observed = await observeMcpEventRequest(request, async () => response, record => records.push(record));
    assert.equal(observed, response);
    assert.deepEqual(await observed.json(), { error: { code: -32015, message: "PRIVATE", data: { url: "PRIVATE" } } });
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], { event: "mcp.events.wire", phase: "received", method: method ?? "unlabelled", protocol: "2026-07-28" });
    assert.deepEqual(records[1], { event: "mcp.events.wire", phase: "returned", method: method ?? "unlabelled",
      protocol: "2026-07-28", httpStatus: 400, rpcCode: -32015 });
    assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
  }
});

test("diagnostics do not observe ordinary tools, outputs or authorization endpoints", async () => {
  for (const [path, method] of [["/mcp", "tools/call"], ["/mcp", "PRIVATE"], ["/authorize", "server/discover"]]) {
    const records: unknown[] = [];
    const response = Response.json({ output: "PRIVATE" });
    assert.equal(await observeMcpEventRequest(new Request(`https://fixture${path}`, {
      method: "POST", headers: { "mcp-method": method },
    }), async () => response, record => records.push(record)), response);
    assert.deepEqual(records, []);
  }
});

test("successful discovery and event listing expose only capability and count", async () => {
  for (const [method, result, summary] of [
    ["server/discover", { capabilities: { events: {} }, private: "PRIVATE" }, { eventsAdvertised: true }],
    ["events/list", { events: [{ name: "PRIVATE", private: "PRIVATE" }] }, { eventCount: 1 }],
  ] as const) {
    const records: unknown[] = [];
    await observeMcpEventRequest(new Request("https://fixture/mcp", { method: "POST", headers: { "mcp-method": method } }),
      async () => Response.json({ result }), record => records.push(record));
    assert.deepEqual(records[1], { event: "mcp.events.wire", phase: "returned", method, protocol: "absent", httpStatus: 200, ...summary });
    assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
  }
});

test("diagnostics preserve authentication responses, non-JSON results and original exceptions", async () => {
  const request = new Request("https://fixture/mcp", { method: "POST", headers: {
    "mcp-method": "events/list", "mcp-protocol-version": "PRIVATE",
  } });
  for (const response of [new Response(null, { status: 401 }), new Response("PRIVATE", { status: 502 })]) {
    const records: unknown[] = [];
    assert.equal(await observeMcpEventRequest(request, async () => response, record => records.push(record)), response);
    assert.deepEqual(records[1], { event: "mcp.events.wire", phase: "returned", method: "events/list", protocol: "other", httpStatus: response.status });
    assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
  }
  const records: unknown[] = [];
  const failure = new Error("PRIVATE");
  await assert.rejects(observeMcpEventRequest(request, async () => { throw failure; }, record => records.push(record)), error => error === failure);
  assert.deepEqual(records[1], { event: "mcp.events.wire", phase: "threw", method: "events/list", protocol: "other" });
  assert.equal(JSON.stringify(records).includes("PRIVATE"), false);
});
