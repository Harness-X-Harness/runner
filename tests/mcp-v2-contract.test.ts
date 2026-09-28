import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
