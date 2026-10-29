import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

test("T3 DO preserves owner pairing privacy, idle exemption and hard-deadline close intent", { timeout: 12000 }, async t => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-object.ts", import.meta.url));
  const environmentId = "env_" + "a".repeat(32);
  const runtimeId = "00000000-0000-4000-8000-000000000001";
  const origin = "https://quiet-leaf.trycloudflare.com";
  const script = [
    "import { EnvironmentObject } from " + JSON.stringify(source) + ";",
    "export class TestT3Environment extends EnvironmentObject {",
    "async fixtureSeed(id, owner, origin) {",
    "  const now = Date.now();",
    '  await this.ctx.storage.put("environment-creation", {environmentId:id, ownerId:owner, executor:"codex", services:["t3"], createdAt:now-16*60000, admitUntil:now+60000});',
    '  await this.ctx.storage.put("environment-runtime", {runtimeId:' + JSON.stringify(runtimeId) + ',generation:1});',
    '  await this.ctx.storage.put("environment-runtime-deadline", now+60000);',
    '  await this.ctx.storage.put("environment-ready-generation", 1);',
    '  await this.ctx.storage.put("environment-t3-state", {t3:{status:"ready", origin}, generation:1, observedAt:now});',
    "}",
    'async fixtureKeys() {return [...(await this.ctx.storage.list()).keys()];}',
    'async fixtureExpire() {await this.ctx.storage.put("environment-runtime-deadline",1); await this.alarm();}',
    "async fetch(request) {",
    '  if(new URL(request.url).pathname !== "/test-socket") return super.fetch(request);',
    '  const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);',
    '  pair[1].serializeAttachment({runtimeId:' + JSON.stringify(runtimeId) + ',generation:1});',
    "  return new Response(null,{status:101,webSocket:pair[0]});",
    "}",
    "}",
    "export default {async fetch(request,env) {",
    '  const input=request.method==="POST"?await request.json():JSON.parse(new URL(request.url).searchParams.get("input"));',
    "  const object=env.ENVIRONMENTS.getByName(input.environmentId);",
    '  if(input.op==="socket")return object.fetch(new Request("https://internal/test-socket",{headers:{upgrade:"websocket"}}));',
    '  if(input.op==="seed"){await object.fixtureSeed(input.environmentId,input.owner,input.origin);return Response.json({ok:true});}',
    '  if(input.op==="keys")return Response.json(await object.fixtureKeys());',
    '  if(input.op==="expire"){await object.fixtureExpire();return Response.json({ok:true});}',
    '  if(input.op==="snapshot")return Response.json(await object.readEnvironment(input.owner));',
    '  if(input.op==="pair"){try{return Response.json({url:await object.issueT3Pairing(input.owner)});}catch{return new Response(null,{status:403});}}',
    "  return new Response(null,{status:404});",
    "}};",
  ].join("\n");
  const built = await build({
    stdin: { contents: script, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0]!.text,
    compatibilityDate: "2026-07-23", cf: false,
    bindings: { ENVIRONMENT_STARTUP_MS: 60000, GITHUB_RUNNER_REPOSITORY: "fixture/runner" },
    durableObjects: { ENVIRONMENTS: { className: "TestT3Environment", useSQLite: true } },
  });
  t.after(() => mf.dispose());
  const call = (op: string, input: Record<string, unknown> = {}) =>
    mf.dispatchFetch("http://test/", { method: "POST", body: JSON.stringify({op, environmentId, ...input}) });
  assert.equal((await call("seed", {owner:"123", origin})).status, 200);
  const upgraded = await mf.dispatchFetch("http://test/?input=" + encodeURIComponent(JSON.stringify({
    op: "socket", environmentId,
  })), { headers: { upgrade: "websocket" } });
  assert.equal(upgraded.status, 101);
  const socket = upgraded.webSocket!;
  socket.accept();
  t.after(() => socket.close());
  const snapshot = await (await call("snapshot", {owner:"123"})).json() as {status:string};
  assert.equal(snapshot.status, "ready");
  const ready = new Promise<string>(resolve => socket.addEventListener("message",
    event => resolve(JSON.parse(String(event.data)).type), { once: true }));
  socket.send(JSON.stringify({ type: "ready" }));
  assert.equal(await ready, "ready-accepted");
  const held = await (await call("snapshot", {owner:"123"})).json() as {
    status: string; idleExpiresAt: number | null; expiresAt: number; createdAt: number;
  };
  assert.equal(held.status, "ready");
  assert.equal(held.idleExpiresAt, null, "interactive T3 must not acquire the ordinary idle deadline");
  assert.ok(Date.now() - held.createdAt > 15 * 60_000, "fixture age crosses the ordinary idle interval");
  assert.ok(held.expiresAt > Date.now(), "hard deadline remains authoritative");
  assert.equal((await call("pair", {owner:"456"})).status, 403);
  let count = 0;
  const requested = new Promise<void>(resolve => {
    socket.addEventListener("message", event => {
      const input = JSON.parse(String(event.data)) as {
        type:string; requestId:string; generation:number; origin:string;
      };
      assert.equal(input.type, "pairing-request");
      assert.equal(input.generation, 1);
      assert.equal(input.origin, origin);
      count++;
      socket.send(JSON.stringify({type:"pairing-result",requestId:input.requestId,
        generation:1,ok:true,pairUrl:origin+"/pair#token=PRIVATE_PAIR_TOKEN"}));
      resolve();
    }, { once: true });
  });
  const pending = call("pair",{owner:"123"});
  await requested;
  const answer = await pending;
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {url:origin+"/pair#token=PRIVATE_PAIR_TOKEN"});
  assert.equal(count, 1);
  const keys = await (await call("keys")).json() as string[];
  assert.ok(!JSON.stringify(keys).includes("PRIVATE_PAIR_TOKEN"));
  assert.ok(!keys.some(key => key.includes("pairing")));
  const close = new Promise<string>(resolve => socket.addEventListener("message",
    event => resolve(JSON.parse(String(event.data)).type), { once: true }));
  assert.equal((await call("expire")).status, 200);
  assert.equal(await close, "close");
  assert.equal((await (await call("snapshot", {owner:"123"})).json() as {status:string}).status, "closing",
    "elapsed deadline is close intent, not confirmed remote job stop");
  assert.equal((await call("pair", {owner:"123"})).status, 403);
});
