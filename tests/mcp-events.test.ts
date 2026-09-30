import test from "node:test";
import assert from "node:assert/strict";
import { environmentTaskAuthority } from "../apps/chatgpt-app/src/environment-task-authority.ts";
import { serveTaskRequest } from "../apps/chatgpt-app/src/task-methods.ts";
import { EVENT_NAME, EventError } from "../apps/chatgpt-app/src/mcp-events.ts";
import { eventGrantAllowed } from "../apps/chatgpt-app/src/event-grants.ts";

test("Events use the authenticated modern endpoint without Tasks and validate ownership before verification", async () => {
  const environmentId = `env_${"a".repeat(32)}`;
  let owner = "1", subscriptions = 0, unsubscriptions = 0;
  const env = { ENVIRONMENT_ADMISSION: { getByName() { throw new Error("unexpected admission"); } },
    ENVIRONMENTS: { getByName(id: string) {
      assert.equal(id, environmentId);
      return { async readEnvironment(principal: string) { return principal === "1" ? { environmentId, status: "opening" } : null; },
        async subscribeEvents(principal: string, grant: unknown) {
          assert.equal(principal, "1"); assert.deepEqual(grant, { userId: "github-1", grantId: "grant", clientId: "client" });
          subscriptions++; throw new EventError(-32015, "Callback verification failed", { reason: "challenge_failed" });
        }, async unsubscribeEvents() { unsubscriptions++; } };
    } },
  };
  const authority = environmentTaskAuthority(env as never, async () => ({ githubUserId: owner, oauthScopes: ["environments:use"],
    mcpGrant: { userId: `github-${owner}`, grantId: "grant", clientId: "client" } }));
  const call = async (method: string, params: Record<string, unknown> = {}, headerName = params.name) => {
    const response = await serveTaskRequest(new Request("https://fixture/mcp", { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28",
      "mcp-method": method, ...(typeof headerName === "string" ? { "mcp-name": headerName } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "ordinary", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
    } } }) }), authority);
    return response.json() as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } }>;
  };
  assert.deepEqual((await call("server/discover")).result?.capabilities, { tools: {}, events: {}, resources: { subscribe: true },
    extensions: { "io.modelcontextprotocol/tasks": {} } });
  const catalog = await call("events/list");
  assert.equal((catalog.result?.events as { name: string }[])[0].name, EVENT_NAME);
  const params = { name: EVENT_NAME, arguments: { environmentId }, cursor: null,
    delivery: { mode: "webhook", url: "https://receiver.example/callback", secret: `whsec_${Buffer.alloc(32).toString("base64")}` } };
  assert.deepEqual((await call("events/subscribe", params)).error,
    { code: -32015, message: "Callback verification failed", data: { reason: "challenge_failed" } });
  assert.equal(subscriptions, 1);
  assert.equal((await call("events/subscribe", params, "other")).error?.code, -32020);
  owner = "2";
  assert.equal((await call("events/subscribe", params)).error?.code, -32012);
  assert.equal(subscriptions, 1);
  owner = "1";
  assert.equal((await call("events/subscribe", { ...params, name: "unknown" })).error?.code, -32011);
  const cancel = { name: EVENT_NAME, arguments: { environmentId }, delivery: { mode: "webhook", url: params.delivery.url } };
  assert.deepEqual((await call("events/unsubscribe", cancel)).result, {});
  assert.equal(unsubscriptions, 1);
});

test("background grant authority uses public provider summaries, including pagination, scope and expiry", async () => {
  const grant = { userId: "github-1", grantId: "grant", clientId: "client" };
  let page = 0;
  const current = { id: "grant", userId: "github-1", clientId: "client", scope: ["environments:use"], createdAt: 1, metadata: {} };
  const api = { async listUserGrants(userId: string, options?: { cursor?: string }) {
    assert.equal(userId, grant.userId);
    page++;
    return options?.cursor ? { items: [current] } : { items: [], cursor: "next" };
  } };
  assert.equal(await eventGrantAllowed(api, grant), true);
  assert.equal(page, 2);
  for (const invalid of [{ ...current, clientId: "other" }, { ...current, userId: "github-2" },
    { ...current, scope: ["tasks:manage"] }, { ...current, expiresAt: 1 }]) {
    assert.equal(await eventGrantAllowed({ async listUserGrants() { return { items: [invalid] }; } }, grant), false);
  }
  assert.equal(await eventGrantAllowed({ async listUserGrants() { return { items: [] }; } }, grant), false);
});
