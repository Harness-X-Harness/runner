import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { createFetchMock, Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";

async function createWorker(t: TestContext, fetchMock?: ReturnType<typeof createFetchMock>) {
  const built = await build({
    entryPoints: [fileURLToPath(new URL("../apps/chatgpt-app/src/index.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    loader: { ".css": "text" },
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers", "node:*"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], cf: false,
    fetchMock,
    kvNamespaces: ["OAUTH_KV"], bindings: { TASK_CONTROL_PLANE_URL: "https://runner.example", ENVIRONMENT_STARTUP_MS: 600000 },
    durableObjects: {
      TASKS: { className: "TaskRuntimeObject", useSQLite: true },
      AUTHORIZATION_STATES: { className: "AuthorizationStateObject", useSQLite: true },
      ENVIRONMENTS: { className: "BoundedEnvironmentObject", useSQLite: true },
      ENVIRONMENT_ADMISSION: { className: "EnvironmentAdmissionObject", useSQLite: true },
    },
  });
  t.after(() => mf.dispose());
  return mf;
}

test("deployed Worker entry shape serves Task OAuth metadata and rejects retired routes", async (t) => {
  const mf = await createWorker(t);
  assert.equal((await mf.dispatchFetch("https://runner.example/health")).status, 200);
  assert.equal((await mf.dispatchFetch(`https://runner.example/internal/environments/env_${"a".repeat(32)}/claim`, { method: "POST" })).status, 401);
  assert.equal((await mf.dispatchFetch("https://runner.example/github/events", { method: "POST", body: "{}" })).status, 503);
  const stylesheet = await mf.dispatchFetch("https://runner.example/assets/authorization.css");
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  assert.match(await stylesheet.text(), /\.radix-themes/);
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await mf.dispatchFetch(`https://runner.example${path}`);
    assert.equal(response.status, 200);
    const metadata = z.object({ scopes_supported: z.array(z.string()) }).parse(await response.json());
    assert.deepEqual(metadata.scopes_supported, ["environments:use", "tasks:manage"]);
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
    assert.match(body, /could not verify your MCP client&#x27;s public metadata/);
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
