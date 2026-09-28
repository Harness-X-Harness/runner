import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";
import { sseMessages } from "./helpers/sse-messages.ts";

test("native startup alarm closes admission without releasing an unconfirmed run", { timeout: 10000 }, async t => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-object.ts", import.meta.url));
  const built = await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
    export { EnvironmentObject, EnvironmentAdmissionObject } from ${JSON.stringify(source)};
    export default { async fetch(request, env) {
      const { operation, id } = await request.json();
      const object = env.ENVIRONMENTS.getByName(id);
      try {
        if (operation === 'open') {
          await object.initialize({ environmentId: id, ownerId: '1', executor: 'codex' });
          return Response.json(await object.beginDispatch('1'));
        }
        if (operation === 'observe') return new Response(await object.observeEnvironment('1'),
          { headers: { 'content-type': 'text/event-stream' } });
        if (operation === 'claim') return Response.json(await object.bindExecution({
          ownerId: '1', repository: 'fixture/runner', runId: '1', runAttempt: '1' }));
        if (operation === 'list') return Response.json(await env.ENVIRONMENT_ADMISSION.getByName('global').list('1'));
        if (operation === 'dispatch') return Response.json(await object.beginDispatch('1'));
        throw new Error('Unexpected test operation');
      } catch { return new Response(null, { status: 409 }); }
    } };` }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"] });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-07-23", cf: false,
    bindings: { ENVIRONMENT_STARTUP_MS: 2000, GITHUB_RUNNER_REPOSITORY: "fixture/runner" },
    durableObjects: { ENVIRONMENTS: { className: "EnvironmentObject", useSQLite: true },
      ENVIRONMENT_ADMISSION: { className: "EnvironmentAdmissionObject", useSQLite: true } },
  });
  t.after(() => mf.dispose());
  const id = `env_${"1".repeat(32)}`;
  const call = (operation: string, target = id) => mf.dispatchFetch("http://fixture", {
    method: "POST", body: JSON.stringify({ operation, id: target }),
  });
  assert.equal(await (await call("open")).json(), "send");
  const events = sseMessages(await call("observe"));
  try {
    // No further request, polling, or manually invoked alarm wakes this stream.
    for (;;) {
      const event = (await events.next()).value as { status: string };
      if (event.status === "closing") break;
    }
    assert.equal((await call("dispatch")).status, 409);
    assert.equal(await (await call("claim")).json(), "stop");
    assert.deepEqual(await (await call("list")).json(), [id]);
    assert.equal((await call("open", `env_${"2".repeat(32)}`)).status, 409);
  } finally { await events.return(undefined); }
});
