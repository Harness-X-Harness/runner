import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { T3Service } from "../.github/actions/agent-runtime/t3-service.ts";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function nativeChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: () => { queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }); return true; },
  });
  return child;
}

test("unexpected native server exit reports failure and revokes tunnel access", async t => {
  const root = await mkdtemp(join(tmpdir(), "t3-lifetime-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = nativeChild();
  let tunnelClosed = false;
  const service = new T3Service({
    workspace: join(root, "project"), env: { HOME: root }, port: await unusedPort(),
    launch: (() => child as unknown as ChildProcess) as typeof spawn,
    fetchImpl: async () => new Response("ok"),
    connect: () => ({
      open: async () => ({ origin: "https://single-leaf.trycloudflare.com" }),
      close: async () => { tunnelClosed = true; },
    }),
  });
  await service.start(new AbortController().signal);
  child.exitCode = 1; child.emit("exit", 1, null);
  assert.equal(service.read().status, "failed");
  await Promise.resolve();
  assert.equal(tunnelClosed, true);
  await service.close();
  assert.equal(service.read().status, "stopped");
});

test("disconnected tunnel invalidates T3 service even if the native process is healthy", async t => {
  const root = await mkdtemp(join(tmpdir(), "t3-lifetime-tunnel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = nativeChild();
  let notify: (() => void) | undefined;
  let stopped = false;
  const service = new T3Service({
    workspace: join(root, "project"), env: { HOME: root }, port: await unusedPort(),
    launch: (() => child as unknown as ChildProcess) as typeof spawn,
    fetchImpl: async () => new Response("ok"),
    connect: () => ({
      open: async () => ({ origin: "https://single-leaf.trycloudflare.com" }),
      close: async () => { stopped = true; },
      subscribe: fn => { notify = fn; return () => {}; },
    }),
  });
  await service.start(new AbortController().signal);
  notify?.();
  await service.close();
  assert.equal(stopped, true);
  assert.equal(service.read().status, "failed");
});

test("Environment abort tears down T3 and rejects further Pairing", async t => {
  const root = await mkdtemp(join(tmpdir(), "t3-lifetime-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const child = nativeChild();
  const service = new T3Service({
    workspace: join(root, "project"), env: { HOME: root }, port: await unusedPort(),
    launch: (() => child as unknown as ChildProcess) as typeof spawn,
    fetchImpl: async () => new Response("ok"),
    connect: () => ({ open: async () => ({ origin: "https://single-leaf.trycloudflare.com" }),
      close: async () => {} }),
  });
  await service.start(controller.signal);
  controller.abort();
  await service.close();
  assert.equal(service.read().status, "stopped");
  await assert.rejects(service.issuePairing("https://single-leaf.trycloudflare.com",
    new AbortController().signal), /T3_PAIRING_UNAVAILABLE/);
  await service.close();
});
