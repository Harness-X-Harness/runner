import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { privateT3Json, liveOrigin, requireTrustedModelContext, verifyModelRun, t3McpFetch, t3PermissionDenied } from "./helpers/t3-live.ts";
import { readT3Descriptor } from "../.github/actions/agent-runtime/t3-readiness.ts";
import { stopManagedProcess } from "../.github/actions/agent-runtime/t3-connection.ts";
import { T3Service } from "../.github/actions/agent-runtime/t3-service.ts";
import { EnvironmentLifetime } from "../.github/actions/agent-runtime/environment-lifetime.ts";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";

const fixture = { environmentId: "local", serverVersion: "0.1.5", capabilities: { repositoryIdentity: true } };

test("MCP denial evidence requires a native capability denial, not a tool, provider or transport failure", () => {
  assert.equal(t3PermissionDenied({isError:true,structuredContent:{code:"capability_denied"}}), true);
  assert.equal(t3PermissionDenied({isError:true,content:[{type:"text",text:JSON.stringify({code:"capability_denied"})}]}), true);
  for (const result of [
    {isError:true,structuredContent:{code:"invalid_request"}},
    {isError:true,structuredContent:{code:"provider_unavailable"}},
    {isError:true,content:[{type:"text",text:"connection failed"}]},
    {isError:false,structuredContent:{code:"capability_denied"}},
    {isError:true,content:[{type:"text",text:"capability_denied"}]},
  ]) assert.equal(t3PermissionDenied(result), false);
});

test("live MCP fetch never forwards credentials or request bodies to a redirect target", async t => {
  let targetHits = 0;
  const target = httpServer((_request, response) => { targetHits++; response.end("unexpected"); });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const destination = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  const origin = httpServer((_request, response) => {
    response.writeHead(307, { location: destination }); response.end();
  });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())),
      new Promise<void>(resolve => target.close(() => resolve()))]);
  });
  const base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`;
  const safeFetch = t3McpFetch(base);
  await assert.rejects(safeFetch(base + "/mcp", { method: "POST", headers: { Authorization: "Bearer PRIVATE_KEY" },
    body: "PRIVATE_PAIRING" }), /^Error: T3_MCP_PRIVATE_FETCH_FAILED$/);
  await assert.rejects(safeFetch(destination), /^Error: T3_MCP_PRIVATE_FETCH_FAILED$/);
  assert.equal(targetHits, 0);
});

test("live CLI failures, timeout and malformed JSON cannot expose captured secrets or argv", async () => {
  for (const source of [
    "console.log('PRIVATE_PAIRING'); console.error('PRIVATE_KEY'); process.exitCode=1",
    "console.error('PRIVATE_KEY'); setInterval(()=>{},1000)",
    "console.log('{PRIVATE_INVALID_JSON')",
  ]) {
    await assert.rejects(privateT3Json(["-e", source, "PRIVATE_ARG"], {
      binary: process.execPath, timeoutMs: 200,
    }), error => {
      assert.ok(error instanceof Error);
      assert.ok(["T3_PRIVATE_CLI_FAILED", "T3_PRIVATE_CLI_JSON_INVALID"].includes(error.message));
      assert.ok(!JSON.stringify(error).includes("PRIVATE_"));
      for (const secret of ["PRIVATE_PAIRING", "PRIVATE_KEY", "PRIVATE_ARG", "PRIVATE_INVALID_JSON"]) {
        assert.ok(!String(error).includes(secret));
      }
      assert.equal("stdout" in error || "stderr" in error || "cause" in error || "cmd" in error, false);
      return true;
    });
  }
  const failed = await privateT3Json(["-e", "console.log(JSON.stringify({status:'failed'}));process.exitCode=1"],
    { binary: process.execPath });
  assert.equal(failed.exitCode, 1, "native terminal failure state must remain inspectable privately");
});

test("paid model checks require explicit trusted selection and reject both PR event contexts", () => {
  const allowed = { T3_LIVE: "1", T3_LIVE_MODEL: "1", T3_LIVE_TRUSTED: "1", T3_LIVE_PROVIDER: "grok",
    T3_LIVE_MODEL_ID: "model", T3_LIVE_PROJECT: "/disposable" };
  assert.doesNotThrow(() => requireTrustedModelContext(allowed));
  for (const patch of [{ T3_LIVE_TRUSTED: "0" }, { T3_LIVE_MODEL: "0" },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "pull_request_target" },
    { T3_LIVE_PROVIDER: "" }, { T3_LIVE_MODEL_ID: "" }, { T3_LIVE_PROJECT: "relative" }]) {
    assert.throws(() => requireTrustedModelContext({ ...allowed, ...patch }), /T3_LIVE_MODEL_/);
  }
  for (const url of ["http://remote.example", "https://user:secret@example.org/mcp", "https://host/mcp?token=secret",
    "https://host/mcp#token=secret", "https://host/pair"]) {
    assert.throws(() => liveOrigin(url, true), /T3_LIVE_ORIGIN_INVALID/);
  }
  assert.equal(liveOrigin("https://public.example/mcp", true), "https://public.example");
});

test("provider proof requires exact reply, provider/model, run ID and settled authoritative state", () => {
  const run = { threadId: "thread", runId: "run", status: "completed", reply: "nonce" };
  const thread = { threadId: "thread", latestRunId: "run", status: "completed", activeRunId: null,
    pendingRequestCount: 0, providerInstanceId: "grok", model: "model" };
  const state = { thread, messages: [{ role: "assistant", runId: "run", text: "nonce" }] };
  assert.doesNotThrow(() => verifyModelRun(run, state, "grok", "model", "nonce"));
  for (const patch of [{ providerInstanceId: "codex" }, { model: "different" }, { latestRunId: "other" },
    { status: "running" }, { activeRunId: "active" }, { pendingRequestCount: 1 }]) {
    assert.throws(() => verifyModelRun(run, { ...state, thread: { ...thread, ...patch } }, "grok", "model", "nonce"),
      /T3_LIVE_RUN_EVIDENCE_INVALID/);
  }
  assert.throws(() => verifyModelRun({ ...run, reply: "PRIVATE_MODEL_TEXT" }, state, "grok", "model", "nonce"),
    /T3_LIVE_RUN_EVIDENCE_INVALID/);
  assert.throws(() => verifyModelRun({ ...run, status: "waiting" }, state, "grok", "model", "nonce"), /T3_LIVE_RUN_WAITING/);
});

test("readiness rejects missing/native-invalid descriptor fields", async () => {
  for (const value of [{}, { ...fixture, environmentId: "" }, { ...fixture, serverVersion: " " },
    { ...fixture, capabilities: null }, { ...fixture, capabilities: [] }, { ...fixture, capabilities: {} }]) {
    assert.equal(await readT3Descriptor("https://public.example", new AbortController().signal,
      async () => Response.json(value)), null);
  }
  assert.deepEqual(await readT3Descriptor("https://public.example", new AbortController().signal,
    async () => Response.json(fixture)), { environmentId: "local", serverVersion: "0.1.5" });
});

test("cleanup kills a real descendant even after its process-group leader has exited", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "t3-descendant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "pid");
  const child = spawn(process.execPath, ["-e", `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    require('node:fs').writeFileSync(process.argv[1],String(child.pid));
    child.unref();
  `, file], { detached: true, stdio: "ignore" });
  t.after(() => stopManagedProcess(child));
  await once(child, "close");
  const pid = Number(await readFile(file, "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0), "descendant really existed after leader exit");
  await stopManagedProcess(child);
  let running = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      running = !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch { running = false; }
    if (!running) break;
    await delay(20);
  }
  assert.equal(running, false, "descendant must no longer execute; an orphan zombie may await host reaping");
});

test("real service startup past a hard deadline closes its process without waiting for readiness", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "t3-startup-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  let child: ReturnType<typeof spawn> | undefined;
  const service = new T3Service({ workspace: root, env: { HOME: root }, executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], port,
    launch: ((...args: Parameters<typeof spawn>) => { child = spawn(...args); return child; }) as typeof spawn,
  });
  const lifetime = new EnvironmentLifetime(Date.now() + 500, () => service.close());
  t.after(() => lifetime.close());
  await assert.rejects(service.start(lifetime.signal), /T3_STARTUP_UNAVAILABLE/);
  await lifetime.stopped;
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null));
  assert.equal(service.read().status, "failed");
  await assert.rejects(service.issuePairing("https://public.example", new AbortController().signal), /T3_PAIRING_UNAVAILABLE/);
});
