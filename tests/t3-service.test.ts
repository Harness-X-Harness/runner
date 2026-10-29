import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { ChildProcess, spawn } from "node:child_process";
import { T3Service } from "../.github/actions/agent-runtime/t3-service.ts";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: () => { queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0, null); }); return true; },
  });
  return child;
}
test("T3 lives across operations, reports public origin, and stops with its Environment", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-t3-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = mockChild();
  let command: string[] = [];
  let tunnelStops = 0;
  const service = new T3Service({
    workspace: join(root, "workspace"),
    env: { HOME: root, MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY", GH_TOKEN: "PRIVATE_WORK_TOKEN" },
    port: await unusedPort(),
    launch: ((binary: string, args: string[]) => {
      command = [binary, ...args];
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    fetchImpl: async () => new Response("OK", { status: 200 }),
    remoteProbe: async () => true,
    connect: () => ({
      open: async () => ({ origin: "https://quiet-leaf.trycloudflare.com" }),
      close: async () => { tunnelStops++; },
    }),
  });
  const updates: string[] = [];
  const unsubscribe = service.subscribe(() => updates.push(service.read().status));
  await service.start(new AbortController().signal);
  assert.deepEqual(service.read(), { status: "ready", origin: "https://quiet-leaf.trycloudflare.com" });
  assert.ok(command.includes("serve"));
  assert.ok(command.includes("--host"));
  assert.ok(command.includes("127.0.0.1"));
  assert.ok(command[0]?.endsWith("/.local/bin/t3"));
  assert.equal(command.includes("--base-dir"), false, "native CLI should use the same HOME as the T3 service");
  await service.close();
  await service.close();
  assert.deepEqual(updates, ["ready", "stopped"]);
  assert.equal(tunnelStops, 1);
  unsubscribe();
});
test("T3 service rejects invalid workspace and never marks an exited server ready", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-t3-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => new T3Service({ workspace: "relative",
    env: { HOME: root } }), /INVALID_T3_SERVICE_OPTIONS/);
  const child = mockChild();
  const service = new T3Service({
    workspace: join(root, "workspace"), env: { HOME: root },
    port: await unusedPort(),
    launch: (() => {
      queueMicrotask(() => { child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); });
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    fetchImpl: async () => { throw new Error("not ready"); },
    remoteProbe: async () => true,
    connect: () => { throw new Error("must not open tunnel"); },
  });
  await assert.rejects(service.start(new AbortController().signal), /T3_STARTUP_UNAVAILABLE/);
  assert.deepEqual(service.read(), { status: "failed" });
});

test("pairing is available only on a live matching T3 origin, never via ordinary command results", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-t3-pairing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = mockChild();
  const origin = "https://quiet-leaf.trycloudflare.com";
  let pairingCli: string[] = [];
  const fakeBinary = join(root, "t3-pairing-fixture");
  // A real subprocess exercises stdout parsing and ensures no credential is printed by the caller.
  const { writeFile, chmod } = await import("node:fs/promises");
  await writeFile(fakeBinary, \`#!/bin/sh
printf '%s\\\\n' '{"pairUrl":"https://quiet-leaf.trycloudflare.com/pair#token=PRIVATE_SECRET_TOKEN"}'
\`);
  await chmod(fakeBinary, 0o700);
  const service = new T3Service({
    workspace: join(root, "workspace"), env: { HOME: root, PATH: "/usr/bin" },
    executable: fakeBinary, port: await unusedPort(),
    launch: (() => child as unknown as ChildProcess) as unknown as typeof spawn,
    fetchImpl: async () => new Response("OK"),
    remoteProbe: async () => true,
    connect: () => ({ open: async () => ({ origin }), close: async () => {} }),
  });
  await service.start(new AbortController().signal);
  await assert.rejects(service.issuePairing("https://different.trycloudflare.com", new AbortController().signal),
    /T3_PAIRING_UNAVAILABLE/);
  const url = await service.issuePairing(origin, new AbortController().signal);
  assert.equal(new URL(url).origin, origin);
  assert.equal(new URL(url).hash, "#token=PRIVATE_SECRET_TOKEN");
  await service.close();
  await assert.rejects(service.issuePairing(origin, new AbortController().signal),
    /T3_PAIRING_UNAVAILABLE/);
});
