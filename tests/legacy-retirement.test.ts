import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

test("operator retirement RPC projects only metadata without applying expiry or changing storage", async t => {
  const object = fileURLToPath(new URL("../apps/chatgpt-app/src/task-runtime-object.ts", import.meta.url));
  const entry = fileURLToPath(new URL("../apps/chatgpt-app/src/legacy-retirement.ts", import.meta.url));
  const built = await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
    import { TaskRuntimeObject } from ${JSON.stringify(object)};
    export { LegacyRetirement } from ${JSON.stringify(entry)};
    export class TestedTask extends TaskRuntimeObject {
      async seed(record) { await this.ctx.storage.put('task', record); }
      async raw() { return this.ctx.storage.get('task'); }
    }
    export default { async fetch(request, env) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });
      const { operation, record } = await request.json();
      const id = env.TASKS.idFromName('retirement-fixture');
      const object = env.TASKS.get(id);
      if (operation === 'seed') { await object.seed(record); return Response.json(null); }
      return Response.json(operation === 'raw' ? await object.raw() : await env.OPERATOR.inspect(id.toString()));
    } };
  ` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });
  const mf = new Miniflare({ name: "retirement-test", modules: true, script: built.outputFiles[0]!.text,
    compatibilityDate: "2026-07-23", cf: false,
    serviceBindings: { OPERATOR: { name: "retirement-test", entrypoint: "LegacyRetirement" } },
    durableObjects: { TASKS: { className: "TestedTask", useSQLite: true } } });
  t.after(() => mf.dispose());
  const call = async (operation: string, record?: unknown) => (await mf.dispatchFetch("http://fixture", {
    method: "POST", body: JSON.stringify({ operation, record }),
  })).json();
  assert.equal(await call("inspect"), null);
  for (const status of ["running", "completed"]) {
    const record = { status, createdAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z",
      expiresAt: 1, ownerId: "PRIVATE_OWNER", prompt: "PRIVATE_PROMPT", result: { finalResponse: "PRIVATE_RESULT" },
      execution: { token: "PRIVATE_TOKEN" } };
    await call("seed", record);
    assert.deepEqual(await call("inspect"), { status, createdAt: record.createdAt,
      finishedAt: record.finishedAt, expiresAt: 1 });
    assert.deepEqual(await call("raw"), record);
  }
  assert.equal((await mf.dispatchFetch("http://fixture/retirement")).status, 404);
});
