import test from "node:test";
import assert from "node:assert/strict";
import { startGithubWaitTool, type GithubRunCompletion } from "../.github/actions/agent-runtime/github-wait-tool.ts";

test("private native MCP wait suspends one call, authenticates and returns only its exact completion", async t => {
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<GithubRunCompletion>();
  let calls = 0;
  const tool = await startGithubWaitTool(async () => { calls++; entered.resolve(); return completion.promise; });
  t.after(() => tool.close());
  assert.equal((await fetch(tool.config.url)).status, 401);
  const headers: Record<string, string> = { authorization: tool.config.headers[0].value,
    "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = (method: string, params: unknown) => fetch(tool.config.url, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200);
  headers["mcp-session-id"] = init.headers.get("mcp-session-id")!;
  await init.json();
  const catalog = await (await rpc("tools/list", {})).json();
  assert.deepEqual(catalog.result.tools.map((tool: { name: string }) => tool.name), ["wait_for_github_run"]);
  const input = { repository: "fixture/repo", runId: "123", runAttempt: 1, revision: "a".repeat(40) };
  const pending = rpc("tools/call", { name: "wait_for_github_run", arguments: input });
  let returned = false;
  void pending.then(() => { returned = true; });
  await entered.promise;
  assert.equal(returned, false);
  completion.resolve({ ...input, conclusion: "success" });
  const response = await (await pending).json();
  assert.deepEqual(response.result.structuredContent, { ...input, conclusion: "success" });
  assert.equal(calls, 1);
  const mismatch = await (await rpc("tools/call", { name: "wait_for_github_run",
    arguments: { ...input, runAttempt: 2 } })).json();
  assert.equal(mismatch.result.isError, true);
  assert.equal(mismatch.result.structuredContent, undefined);
  const rejected = await (await rpc("tools/call", { name: "wait_for_github_run",
    arguments: { ...input, ownerId: "injected" } })).json();
  assert.ok(rejected.error || rejected.result?.isError);
  assert.equal(calls, 2);
});

test("closing the private tool aborts an active wait and does not publish a completion", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const tool = await startGithubWaitTool(async (_input, signal) => {
    entered.resolve(signal);
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("PRIVATE_BACKEND_DIAGNOSTIC")), { once: true });
    });
    throw new Error("unreachable");
  });
  const headers: Record<string, string> = { authorization: tool.config.headers[0].value,
    "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = (method: string, params: unknown) => fetch(tool.config.url, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    headers["mcp-session-id"] = init.headers.get("mcp-session-id")!;
    await init.json();
    const pending = rpc("tools/call", { name: "wait_for_github_run", arguments: {
      repository: "fixture/repo", runId: "123", runAttempt: 1, revision: "a".repeat(40),
    } }).then(response => response.text()).catch(() => "CONNECTION_CLOSED");
    const signal = await entered.promise;
    await tool.close();
    assert.equal(signal.aborted, true);
    const result = await pending;
    assert.ok(!result.includes("PRIVATE_BACKEND_DIAGNOSTIC"));
    assert.ok(!result.includes('"conclusion"'));
    await tool.close();
  } finally { await tool.close(); }
});
