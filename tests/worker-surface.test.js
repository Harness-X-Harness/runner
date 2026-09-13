import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { createFetchMock, Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

async function createWorker(t, fetchMock) {
  const built = await build({
    entryPoints: [fileURLToPath(new URL("../apps/chatgpt-app/src/index.js", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers", "node:*"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], cf: false,
    fetchMock,
    kvNamespaces: ["OAUTH_KV"], bindings: { TASK_CONTROL_PLANE_URL: "https://runner.example" },
    durableObjects: {
      TASKS: { className: "TaskRuntimeObject", useSQLite: true },
      AUTHORIZATION_STATES: { className: "AuthorizationStateObject", useSQLite: true },
    },
  });
  t.after(() => mf.dispose());
  return mf;
}

test("deployed Worker entry shape serves Task OAuth metadata and rejects retired routes", async (t) => {
  const mf = await createWorker(t);
  assert.equal((await mf.dispatchFetch("https://runner.example/health")).status, 200);
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await mf.dispatchFetch(`https://runner.example${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).scopes_supported, ["tasks:manage"]);
  }
  for (const path of ["/environment", "/session-stream/old", "/internal/environments/old/claim"]) {
    for (const method of ["GET", "POST"]) {
      assert.equal((await mf.dispatchFetch(`https://runner.example${path}`, { method })).status, 404);
    }
  }
});

const clientId = "https://client.example/oauth/client.json";
const redirectUri = "https://client.example/callback";
const clientDocument = {
  client_id: clientId,
  client_name: "CIMD client",
  redirect_uris: [redirectUri],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
};

function authorizeUrl(redirect = redirectUri) {
  const url = new URL("https://runner.example/authorize");
  url.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect,
    scope: "tasks:manage", state: "private-client-state",
    code_challenge: "x".repeat(43), code_challenge_method: "S256",
    resource: "https://runner.example/mcp",
  }).toString();
  return url;
}

for (const failedLookup of [1, 2]) {
  test(`CIMD lookup ${failedLookup} upstream 403 is a local safe 503, not an uncaught Worker error`, async (t) => {
    const fetchMock = createFetchMock();
    fetchMock.disableNetConnect();
    const origin = fetchMock.get("https://client.example");
    for (let lookup = 1; lookup <= failedLookup; lookup++) {
      origin.intercept({ path: "/oauth/client.json", method: "GET" })
        .reply(lookup === failedLookup ? 403 : 200,
          lookup === failedLookup ? "private-upstream-response" : JSON.stringify(clientDocument),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const mf = await createWorker(t, fetchMock);
    const response = await mf.dispatchFetch(authorizeUrl());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.has("location"), false);
    assert.equal(response.headers.has("set-cookie"), false);
    const body = await response.text();
    assert.match(body, /Authorization temporarily unavailable/);
    assert.match(body, /could not verify your MCP client's public metadata/);
    assert.doesNotMatch(body, /private-client-state|private-upstream-response|client\.example|CimdFetchError|Continue with GitHub/);
    fetchMock.assertNoPendingInterceptors();

    // A later user request can succeed when the origin recovers; no fallback or negative cache.
    origin.intercept({ path: "/oauth/client.json", method: "GET" })
      .reply(200, JSON.stringify(clientDocument),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }).times(2);
    const recovered = await mf.dispatchFetch(authorizeUrl());
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /Run and control code tasks/);
    fetchMock.assertNoPendingInterceptors();
  });
}

test("CIMD success still rejects a redirect absent from the client document", async (t) => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get("https://client.example").intercept({ path: "/oauth/client.json", method: "GET" })
    .reply(200, JSON.stringify(clientDocument), { headers: { "content-type": "application/json" } });
  const mf = await createWorker(t, fetchMock);
  const response = await mf.dispatchFetch(authorizeUrl("https://untrusted.example/callback"));
  assert.equal(response.status, 400);
  assert.equal(response.headers.has("location"), false);
  assert.equal(response.headers.has("set-cookie"), false);
  fetchMock.assertNoPendingInterceptors();
});
