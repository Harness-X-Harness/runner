import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

for (const closeMode of ["explicit", "deadline"] as const) test(`T3 DO preserves pairing privacy and holds capacity until exact stop after ${closeMode} close`, { timeout: 12000 }, async t => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-object.ts", import.meta.url));
  const environmentId = "env_" + "a".repeat(32);
  const runtimeId = "00000000-0000-4000-8000-000000000001";
  const origin = "https://quiet-leaf.trycloudflare.com";
  const script = [
    "import { EnvironmentObject, EnvironmentAdmissionObject } from " + JSON.stringify(source) + ";",
    "export { EnvironmentAdmissionObject };",
    "export class TestT3Environment extends EnvironmentObject {",
    "async fixtureSeed(id, owner, origin) {",
    "  const now = Date.now();",
    '  await this.ctx.storage.put("environment-creation", {environmentId:id, ownerId:owner, executor:"codex", services:["t3"], createdAt:now-16*60000, admitUntil:now+60000});',
    '  await this.env.ENVIRONMENT_ADMISSION.getByName("global").reserve({environmentId:id,ownerId:owner,admitUntil:now+60000});',
    '  await this.ctx.storage.put("environment-execution", {ownerId:owner,repository:"fixture/runner",runId:"100",runAttempt:"2"});',
    '  await this.ctx.storage.put("environment-dispatch-issued", true);',
    '  await this.ctx.storage.put("environment-runtime", {runtimeId:' + JSON.stringify(runtimeId) + ',generation:1});',
    '  await this.ctx.storage.put("environment-runtime-deadline", now+60000);',
    '  await this.ctx.storage.put("environment-ready-generation", 1);',
    '  await this.ctx.storage.put("environment-t3-state", {t3:{status:"ready", origin}, generation:1, observedAt:now});',
    "}",
    'async fixtureStorage() {return [...(await this.ctx.storage.list()).entries()];}',
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
    '  if(input.op==="storage")return Response.json(await object.fixtureStorage());',
    '  if(input.op==="expire"){await object.fixtureExpire();return Response.json({ok:true});}',
    '  if(input.op==="close")return Response.json(await object.requestClose(input.owner));',
    '  if(input.op==="held")return Response.json(await env.ENVIRONMENT_ADMISSION.getByName("global").held());',
    '  if(input.op==="confirm"){try{return Response.json(await object.confirmExecutionStopped(input.execution));}catch{return new Response(null,{status:409});}}',
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
    durableObjects: { ENVIRONMENTS: { className: "TestT3Environment", useSQLite: true },
      ENVIRONMENT_ADMISSION: { className: "EnvironmentAdmissionObject", useSQLite: true } },
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
  const stored = await (await call("storage")).json() as [string, unknown][];
  assert.ok(!JSON.stringify(stored).includes("PRIVATE_PAIR_TOKEN"), "neither keys nor values may retain pairing secrets");
  assert.ok(!stored.some(([key]) => key.includes("pairing")));
  const nextMessage = () => new Promise<Record<string, unknown>>(resolve => socket.addEventListener("message",
    event => resolve(JSON.parse(String(event.data))), { once: true }));
  const serviceState = async (t3: Record<string, unknown>) => {
    const accepted = nextMessage();
    socket.send(JSON.stringify({type:"service-state", generation:1, t3}));
    assert.equal((await accepted).type, "service-state-accepted");
  };
  for (const t3 of [{status:"failed"}, {status:"ready", origin:"https://other-leaf.trycloudflare.com"}]) {
    const requested = nextMessage();
    const pending = call("pair", {owner:"123"});
    const request = await requested;
    assert.equal(request.type, "pairing-request");
    assert.equal((await call("pair", {owner:"123"})).status, 403, "only one private request may be outstanding");
    await serviceState(t3);
    socket.send(JSON.stringify({type:"pairing-result", requestId:request.requestId,
      generation:1, ok:true, pairUrl:origin+"/pair#token=PRIVATE_STALE_TOKEN"}));
    const denied = await pending;
    assert.equal(denied.status, 403, "a changed or failed service cannot release an outstanding credential");
    assert.doesNotMatch(await denied.text(), /PRIVATE_STALE_TOKEN/);
    await serviceState({status:"ready", origin});
  }
  const requestedAtDeadline = nextMessage();
  const pendingAtDeadline = call("pair", {owner:"123"});
  assert.equal((await requestedAtDeadline).type, "pairing-request");
  const close = new Promise<string>(resolve => socket.addEventListener("message",
    event => resolve(JSON.parse(String(event.data)).type), { once: true }));
  assert.equal((await call(closeMode === "deadline" ? "expire" : "close", {owner:"123"})).status, 200);
  assert.equal(await close, "close");
  assert.equal((await pendingAtDeadline).status, 403, "close intent must immediately refuse pending pairing");
  assert.equal((await (await call("snapshot", {owner:"123"})).json() as {status:string}).status, "closing",
    "elapsed deadline is close intent, not confirmed remote job stop");
  assert.equal((await call("pair", {owner:"123"})).status, 403);
  assert.deepEqual(await (await call("held")).json(), [environmentId], "close intent must retain capacity");
  const execution = {ownerId:"123", repository:"fixture/runner", runId:"100", runAttempt:"2"};
  for (const patch of [{ownerId:"456"}, {repository:"fixture/other"}, {runId:"101"}, {runAttempt:"1"}]) {
    assert.equal((await call("confirm", {execution:{...execution,...patch}})).status, 409);
    assert.deepEqual(await (await call("held")).json(), [environmentId]);
  }
  assert.equal((await call("confirm", {execution})).status, 200);
  const closed = await (await call("snapshot", {owner:"123"})).json() as {
    status:string; services:{t3:{status:string;origin?:string}};
  };
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.services.t3, {status:"stopped"}, "confirmed closure removes public service access");
  assert.deepEqual(await (await call("held")).json(), []);
  assert.equal((await call("confirm", {execution})).status, 200, "duplicate stop evidence is idempotent");
  assert.equal((await call("pair", {owner:"123"})).status, 403);
});
