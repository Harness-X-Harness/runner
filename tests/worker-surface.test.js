import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

test("deployed Worker entry shape serves Task OAuth metadata and rejects retired routes", async (t) => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL("../apps/chatgpt-app/src/index.js", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:workers", "node:*"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], cf: false,
    kvNamespaces: ["OAUTH_KV"], bindings: { TASK_CONTROL_PLANE_URL: "https://runner.example" },
    durableObjects: {
      TASKS: { className: "TaskRuntimeObject", useSQLite: true },
      AUTHORIZATION_STATES: { className: "AuthorizationStateObject", useSQLite: true },
    },
  });
  t.after(() => mf.dispose());
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
