import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

test("Events activate and retain typed callback failures across real SQLite DO RPC", async t => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-events.ts", import.meta.url));
  const oauthSource = fileURLToPath(new URL("../apps/chatgpt-app/src/oauth-options.ts", import.meta.url));
  const providerSource = fileURLToPath(new URL("../apps/chatgpt-app/node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js", import.meta.url));
  const methodsSource = fileURLToPath(new URL("../apps/chatgpt-app/src/task-methods.ts", import.meta.url));
  const eventSource = fileURLToPath(new URL("../apps/chatgpt-app/src/mcp-events.ts", import.meta.url));
  const built = await build({ stdin: { contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { EnvironmentEvents } from ${JSON.stringify(source)};
    import { oauthOptions } from ${JSON.stringify(oauthSource)};
    import { getOAuthApi } from ${JSON.stringify(providerSource)};
    import { serveTaskRequest } from ${JSON.stringify(methodsSource)};
    import { eventRpc, eventRpcValue } from ${JSON.stringify(eventSource)};
    export class EventsObject extends DurableObject {
      events = new EnvironmentEvents(this.ctx.storage, {
        allowed: async () => true,
        deliver: async request => ({ kind: 'response', status: request.url.endsWith('/reject') ? 503 : 200,
          body: JSON.stringify({ challenge: JSON.parse(request.body).challenge }) }),
      });
      async subscribe(input) { return eventRpc(() => this.events.subscribe('1', { userId: 'github-1', grantId: 'grant', clientId: 'client' }, input, { kind: 'environment', status: 'opening' })); }
      async read() { return this.ctx.storage.list({ prefix: 'environment-event-sub:' }); }
      async alarm() { await this.events.flush(); }
    }
    export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/protocol') return serveTaskRequest(request, {
        events: { handle: async input => eventRpcValue(await env.EVENTS.getByName('one').subscribe(input.params)) },
      });
      if (new URL(request.url).pathname === '/provider') {
        try { return Response.json(await getOAuthApi(oauthOptions(env), env).listUserGrants('github-1')); }
        catch (error) { return Response.json({ error: { name: error.name, message: error.message } }); }
      }
      try { return Response.json(await env.EVENTS.getByName('one').subscribe(await request.json())); }
      catch (error) { return Response.json({ error: { name: error.name, message: error.message, code: error.code } }); }
    } };`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"] });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], cf: false,
    bindings: { TASK_CONTROL_PLANE_URL: "https://fixture.example", GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret" },
    kvNamespaces: ["OAUTH_KV"],
    durableObjects: { EVENTS: { className: "EventsObject", useSQLite: true } } });
  t.after(() => mf.dispose());
  const provider = await (await mf.dispatchFetch('http://fixture/provider')).json();
  assert.equal(provider.error, undefined);
  assert.deepEqual(provider.items, []);
  const input = { name: "environment.updated", arguments: { environmentId: `env_${"a".repeat(32)}` },
    delivery: { mode: "webhook", url: "https://receiver.example", secret: `whsec_${Buffer.alloc(32).toString("base64")}` } };
  const response = await mf.dispatchFetch("http://fixture/", { method: "POST", body: JSON.stringify(input) });
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.equal(body.ok, true);
  assert.match(body.value.id, /^sub_/);
  const denied = await (await mf.dispatchFetch("http://fixture/", { method: "POST", body: JSON.stringify({
    ...input, delivery: { ...input.delivery, url: "https://receiver.example/reject" },
  }) })).json();
  assert.equal(denied.error.code, -32015);
  const protocol = await (await mf.dispatchFetch("http://fixture/protocol", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28", "mcp-method": "events/subscribe", "mcp-name": "environment.updated",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/subscribe", params: {
    ...input, delivery: { ...input.delivery, url: "https://receiver.example/reject" }, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  } }) })).json();
  assert.deepEqual(protocol.error, { code: -32015, message: "Callback verification failed", data: { reason: "http_5xx" } });
});
