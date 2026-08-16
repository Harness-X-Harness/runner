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

test("MCP v2 serves modern and legacy tools/list metadata", async () => {
  const props = {
    githubUserId: "test-user",
    oauthScopes: ["tasks:read", "tasks:run", "tasks:cancel", "repos:read", "repos:write", "pull_requests:write"],
  };
  const modernBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "contract-test", version: "1.0.0" },
      },
    },
  };
  const modernResponse = await handleMcpRequest(
    new Request("https://runner.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify(modernBody),
    }),
    {},
    props,
    { props },
  );
  assert.equal(modernResponse.status, 200);
  const modernTools = (await modernResponse.json()).result.tools;
  assert.equal(modernTools.length, 4);
  assert.deepEqual(modernTools.find(({ name }) => name === "submit_task").securitySchemes, [
    { type: "oauth2", scopes: ["tasks:run", "repos:read", "repos:write", "pull_requests:write"] },
  ]);

  const legacyResponse = await handleMcpRequest(
    new Request("https://runner.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    {},
    props,
    { props },
  );
  assert.equal(legacyResponse.status, 200);
  const eventData = (await legacyResponse.text()).match(/^data: (.+)$/m)?.[1];
  assert.ok(eventData);
  const legacyTools = JSON.parse(eventData).result.tools;
  assert.equal(legacyTools.length, 4);
  assert.deepEqual(legacyTools.find(({ name }) => name === "get_task").annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
});
