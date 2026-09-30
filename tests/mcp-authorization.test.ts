import test from "node:test";
import assert from "node:assert/strict";
import type { TokenSummary } from "../apps/chatgpt-app/node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js";
import { mcpAuthorization } from "../apps/chatgpt-app/src/mcp-authorization.ts";

test("subscription authorization rereads token authority and uses token scopes, not cached grant props", async () => {
  const resource = "https://runner.example/mcp";
  const valid: TokenSummary<unknown> = { id: "id", grantId: "grant", userId: "github-123",
    createdAt: 1, expiresAt: Date.now() / 1000 + 60, audience: resource, scope: ["environments:use"],
    grant: { clientId: "client", scope: ["environments:use"],
      props: { githubUserId: "123", oauthScopes: ["obsolete:scope"],
        mcpGrant: { userId: "FORGED", grantId: "FORGED", clientId: "FORGED" } } } };
  let current: TokenSummary<unknown> | null = valid;
  let reads = 0;
  const env = { TASK_CONTROL_PLANE_URL: "https://runner.example", OAUTH_PROVIDER: {
    async unwrapToken<T>(token: string): Promise<TokenSummary<T> | null> {
      assert.equal(token, "PRIVATE_BEARER"); reads++; return current as TokenSummary<T> | null;
    },
  } };
  const authorize = mcpAuthorization(new Request(resource, { headers: { authorization: "Bearer PRIVATE_BEARER" } }), env);
  assert.deepEqual((await authorize()).oauthScopes, ["environments:use"]);
  assert.deepEqual((await authorize()).mcpGrant, { userId: "github-123", grantId: "grant", clientId: "client" });
  for (const invalid of [null, { ...valid, expiresAt: 1 }, { ...valid, audience: "https://other.example/mcp" },
    { ...valid, userId: "github-456" }]) {
    current = invalid;
    await assert.rejects(authorize());
  }
  assert.equal(reads, 6);
  current = { ...valid, scope: [] };
  assert.deepEqual((await authorize()).oauthScopes, []);
  const count = reads;
  await assert.rejects(mcpAuthorization(new Request(resource), env)());
  assert.equal(reads, count);
});
