import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

test("Environment capacity is atomic on workerd SQLite", async t => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-admission.ts", import.meta.url));
  const built = await build({
    stdin: { contents: `import { DurableObject } from 'cloudflare:workers';
      import { EnvironmentAdmission } from ${JSON.stringify(source)};
      export class TestedAdmission extends DurableObject {
        async fetch(request: Request) {
          const { ownerId, environmentId, admitUntil } = await request.json();
          // Reconstruct the service for every request; no process-local reservation cache.
          const admission = new EnvironmentAdmission(this.ctx.storage);
          try {
            switch (new URL(request.url).pathname) {
              case '/reserve': await admission.reserve(ownerId, environmentId, admitUntil); break;
              case '/release': await admission.releaseConfirmed(ownerId, environmentId); break;
              case '/list': return Response.json(await admission.list(ownerId));
              default: return new Response(null, { status: 404 });
            }
            return new Response(null, { status: 204 });
          } catch { return new Response(null, { status: 409 }); }
        }
      }`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", cf: false,
    durableObjects: { ADMISSION: { className: "TestedAdmission", useSQLite: true } },
  });
  t.after(() => mf.dispose());
  const namespace = await mf.getDurableObjectNamespace("ADMISSION");
  const stub = namespace.get(namespace.idFromName("capacity"));
  const id = (n: number) => `env_${n.toString(16).padStart(32, "0")}`;
  const admitUntil = Date.now() + 60000;
  const call = (operation: string, ownerId: string, environmentId?: string) =>
    stub.fetch(`http://admission/${operation}`, {
      method: "POST", body: JSON.stringify({ ownerId, environmentId, admitUntil }),
      headers: { "content-type": "application/json" },
    });
  const responses = await Promise.all(Array.from({ length: 5 }, (_, n) => call("reserve", String(n + 1), id(n + 1))));
  assert.equal(responses.filter(response => response.status === 204).length, 4);
  assert.equal(responses.filter(response => response.status === 409).length, 1);
  const winner = responses.findIndex(response => response.status === 204) + 1;
  const loser = responses.findIndex(response => response.status === 409) + 1;
  assert.deepEqual(await (await call("list", String(winner))).json(), [id(winner)]);
  assert.deepEqual(await (await call("list", String(loser))).json(), []);
  assert.equal((await call("reserve", String(winner), id(winner))).status, 204);
  assert.equal((await call("reserve", String(winner), id(99))).status, 409);
  assert.equal((await call("release", String(loser), id(winner))).status, 409);
  assert.equal((await call("release", String(winner), id(winner))).status, 204);
  assert.equal((await call("reserve", String(winner), id(winner))).status, 409);
  assert.equal((await call("reserve", String(loser), id(loser))).status, 204);
});
