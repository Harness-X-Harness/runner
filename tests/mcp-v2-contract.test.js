import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleMcpRequest } from "../apps/chatgpt-app/src/mcp.js";
import {
  authorizationServerIssuer,
  canonicalMcpResource,
  requireCanonicalResourceParameter,
} from "../apps/chatgpt-app/src/oauth-resource.js";

test("OAuth resource metadata binds the control plane to /mcp", async () => {
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/index.js", import.meta.url),
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

test("MCP control plane declares the stateless SDK v2 boundary", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../apps/chatgpt-app/package.json", import.meta.url),
    "utf8",
  ));
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/mcp.js", import.meta.url),
    "utf8",
  );

  assert.equal(packageJson.dependencies.agents, "0.20.1");
  assert.equal(packageJson.dependencies["@modelcontextprotocol/server"], "2.0.0");
  assert.equal(packageJson.dependencies["@modelcontextprotocol/sdk"], undefined);
  assert.match(source, /from "agents\/mcp\/server"/);
  assert.match(source, /from "@modelcontextprotocol\/server"/);
  assert.doesNotMatch(source, /from "agents\/mcp"/);
  assert.doesNotMatch(source, /from "@modelcontextprotocol\/sdk/);
  assert.doesNotMatch(source, /sessionIdGenerator|enableJsonResponse|_requestHandlers/);
});

test("MCP serves only Task tools to modern and legacy stateless clients", async () => {
  async function request(method, params = {}, modern = true) {
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
    }), { TASK_CONTROL_PLANE_URL: "https://runner.example" }, props, { props });
  }
  const modern = await request("tools/list");
  assert.equal(modern.status, 200);
  const tools = (await modern.json()).result.tools;
  assert.deepEqual(tools.map(t=>t.name), ["run_task", "wait_task", "cancel_task"]);
  for (const tool of tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["tasks:manage"] }]);
    assert.equal(tool._meta.ui, undefined);
    assert.equal(tool._meta["openai/outputTemplate"], undefined);
  }
  const legacy = await request("tools/list", {}, false);
  assert.equal(legacy.status, 200);
  const event = (await legacy.text()).split("\n").find(line=>line.startsWith("data: "));
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
