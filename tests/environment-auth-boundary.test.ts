import test from "node:test";
import assert from "node:assert/strict";
import type { TokenSummary } from "../apps/chatgpt-app/node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js";
import { handleEnvironmentTaskRequest } from "../apps/chatgpt-app/src/environment-task-authority.ts";

test("Environment entry uses standard bearer challenges before protocol work", async () => {
  const resource = "https://runner.example/mcp";
  const valid: TokenSummary<unknown> = { id: "id", grantId: "grant", userId: "github-123",
    createdAt: 1, expiresAt: Date.now() / 1000 + 60, audience: resource, scope: ["environments:use"],
    grant: { clientId: "fixture", scope: ["environments:use"], props: { githubUserId: "123" } } };
  let current: TokenSummary<unknown> | null = valid;
  let failure = false;
  let reads = 0;
  const unexpected = (): never => { throw new Error("Unexpected storage access"); };
  const env = { TASK_CONTROL_PLANE_URL: "https://runner.example",
    ENVIRONMENTS: { getByName: unexpected }, ENVIRONMENT_ADMISSION: { getByName: unexpected },
    OAUTH_PROVIDER: { async unwrapToken<T>(): Promise<TokenSummary<T> | null> {
      reads++;
      if (failure) throw new Error("PRIVATE_TOKEN_STORE_FAILURE");
      return current as TokenSummary<T> | null;
    } },
  };
  const request = (bearer = true, method = "tools/list") => handleEnvironmentTaskRequest(new Request(resource, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...(bearer ? { authorization: "Bearer PRIVATE_ACCESS_TOKEN" } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  }), env);
  const missing = await request(false);
  assert.equal(missing.status, 401);
  assert.equal(reads, 0);
  assert.equal((await request(false, "server/discover")).status, 401);
  assert.match(missing.headers.get("www-authenticate")!, /resource_metadata="https:\/\/runner.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  for (const token of [null, { ...valid, expiresAt: 1 }, { ...valid, audience: "https://other.example/mcp" }]) {
    current = token;
    const response = await request();
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /invalid_token/);
  }
  current = { ...valid, scope: ["tasks:manage"] };
  const denied = await request();
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate")!, /insufficient_scope/);
  assert.match(denied.headers.get("www-authenticate")!, /scope="environments:use"/);
  assert.equal((await request(true, "server/discover")).status, 403);
  current = valid;
  assert.equal((await request()).status, 200);
  assert.equal((await request(true, "server/discover")).status, 200);
  failure = true;
  const unavailable = await request();
  assert.equal(unavailable.status, 500);
  assert.ok(!(await unavailable.text()).includes("PRIVATE_"));
});
