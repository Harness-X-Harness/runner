import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { T3Connection, t3PublicOrigin } from "../.github/actions/agent-runtime/t3-connection.ts";

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
    kill: () => { queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0, null); }); return true; },
  });
  return child;
}
test("tunnel address parser accepts only native HTTPS Quick Tunnel origins", () => {
  assert.equal(t3PublicOrigin("Tunnel https://silent-tree.trycloudflare.com is ready"),
    "https://silent-tree.trycloudflare.com");
  assert.equal(t3PublicOrigin("https://silent-tree.trycloudflare.com.attacker.invalid"), null);
  assert.equal(t3PublicOrigin("http://silent-tree.trycloudflare.com"), null);
  assert.equal(t3PublicOrigin("https://attacker.example"), null);
});

test("managed T3 connection returns only the public origin, never raw logs or pairing secrets", async () => {
  const child = mockChild();
  let invocation: string[] = [];
  let tunnelEnv: NodeJS.ProcessEnv | undefined;
  const launch = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    invocation = [command, ...args];
    tunnelEnv = options.env;
    queueMicrotask(() => {
      child.stderr.write("private diagnostic\n");
      child.stderr.write("Started https://silent-tree.trycloudflare.com\n");
      child.stderr.write("PRIVATE_PAIRING_SECRET\n");
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const connection = new T3Connection(3773, {
    PATH: "/usr/bin", HOME: "/tmp", GH_TOKEN: "PRIVATE_WORK_TOKEN",
    MINI_END_USER_KEY: "PRIVATE_PROVIDER_SECRET", GITHUB_TOKEN: "PRIVATE_JOB_TOKEN",
  }, launch);
  assert.deepEqual(await connection.open(new AbortController().signal), {
    origin: "https://silent-tree.trycloudflare.com",
  });
  assert.deepEqual(invocation, ["cloudflared", "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3773"]);
  assert.deepEqual(tunnelEnv, { PATH: "/usr/bin", HOME: "/tmp" });
  assert.ok(!JSON.stringify(tunnelEnv).includes("PRIVATE_"));
  await connection.close();
  assert.equal(child.exitCode, 0);
});

test("cancelled tunnel acquisition does not spawn or disclose credentials", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let called = false;
  const launch = (() => { called = true; throw new Error("must not spawn"); }) as unknown as typeof spawn;
  const connection = new T3Connection(3773, {}, launch);
  await assert.rejects(connection.open(ctl.signal));
  assert.equal(called, false);
  assert.equal(t3PublicOrigin("PRIVATE_PAIRING_SECRET"), null);
});
