import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";

import { handleMcpRequest } from "../apps/chatgpt-app/src/mcp.ts";
import {
  authorizationServerIssuer,
  canonicalMcpResource,
  requireCanonicalResourceParameter,
} from "../apps/chatgpt-app/src/oauth-resource.ts";

test("OAuth resource metadata binds the control plane to /mcp", async () => {
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/index.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    canonicalMcpResource("https://runner.example/control-plane"),
    "https://runner.example/mcp",
  );
  assert.equal(
    authorizationServerIssuer("https://runner.example/control-plane"),
    "https://runner.example",
  );
  assert.equal(
    await requireCanonicalResourceParameter(
      new Request("https://runner.example/authorize?resource=https%3A%2F%2Frunner.example%2Fmcp"),
    ),
    undefined,
  );
  const missingResource = await requireCanonicalResourceParameter(
    new Request("https://runner.example/authorize"),
  );
  assert.ok(missingResource);
  assert.equal(missingResource.status, 400);
  assert.deepEqual(await missingResource.json(), {
    error: "invalid_target",
    error_description: "resource must be provided for the canonical MCP resource",
  });
  assert.equal(
    await requireCanonicalResourceParameter(
      new Request("https://runner.example/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&resource=https%3A%2F%2Frunner.example%2Fmcp",
      }),
    ),
    undefined,
  );
  assert.equal(
    await requireCanonicalResourceParameter(
      new Request("https://runner.example/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=opaque-token",
      }),
    ),
    undefined,
  );
  assert.match(source, /resource: canonicalResource/);
  assert.match(source, /authorization_servers: \[authorizationServerIssuer\(/);
  assert.match(source, /requireCanonicalResourceParameter/);
  assert.doesNotMatch(source, /resourceMatchOriginOnly/);
});

test("retained Tasks serve only observation and stop to modern and legacy stateless clients", async () => {
  async function request(method: string, params: { name?: string; uri?: string; arguments?: Record<string, unknown> } = {}, modern = true) {
    const props = { githubUserId: "test-user", oauthScopes: ["tasks:manage"] };
    return handleMcpRequest(new Request("https://runner.example/mcp", {
      method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(modern ? { "mcp-method": method, "mcp-protocol-version": "2026-07-28" } : {}),
        ...(modern && (params.name || params.uri) ? { "mcp-name": params.name || params.uri } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {
        ...params,
        ...(modern ? { _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "contract-test", version: "1" },
        } } : {}),
      } }),
    }), {
      GITHUB_RUNNER_REPOSITORY: "example/runner",
      get TASKS(): never { return assert.fail("discovery must not access Task storage"); },
    }, props, {
      props, exports: {},
      get tracing(): never { return assert.fail("unexpected tracing access"); },
      waitUntil: () => assert.fail("discovery must not start background work"),
      passThroughOnException: () => assert.fail("MCP must not bypass the handler"),
    });
  }
  const modern = await request("tools/list");
  assert.equal(modern.status, 200);
  assert.equal(modern.headers.get("mcp-session-id"), null);
  const tools = z.object({ result: z.object({ tools: z.array(z.looseObject({
    name: z.string(), securitySchemes: z.unknown(), _meta: z.record(z.string(), z.unknown()),
  })) }) }).parse(await modern.json()).result.tools;
  assert.deepEqual(tools.map(t=>t.name), ["wait_task", "cancel_task"]);
  for (const tool of tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["tasks:manage"] }]);
    assert.equal(tool._meta.ui, undefined);
    assert.equal(tool._meta["openai/outputTemplate"], undefined);
  }
  const legacy = await request("tools/list", {}, false);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  const event = (await legacy.text()).split("\n").find(line=>line.startsWith("data: "));
  assert.ok(event, "legacy response must contain a JSON-RPC SSE event");
  assert.deepEqual(JSON.parse(event.slice(6)).result.tools, tools);
  for (const method of ["resources/list", "resources/read"]) {
    const response = await request(method, method === "resources/read" ? { uri: "ui://session/v3.html" } : {});
    assert.equal((await response.json()).error.code, -32601);
  }
  for (const name of ["open_environment", "close_environment", "start_session", "list_sessions", "read_session", "send_turn"]) {
    const response = await request("tools/call", { name, arguments: {} });
    const body = await response.json();
    assert.ok(body.error || body.result?.isError);
  }
});
