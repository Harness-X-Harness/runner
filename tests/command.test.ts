import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand, type CommandContext } from "../.github/actions/agent-runtime/command.ts";
import { EnvironmentRuntime } from "../.github/actions/agent-runtime/environment-runtime.ts";
import { EnvironmentLifetime } from "../.github/actions/agent-runtime/environment-lifetime.ts";

async function fixture(run: (context: CommandContext) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "harness-command-"));
  try {
    await run({ workspace, deadline: Date.now() + 10000,
      env: { PATH: process.env.PATH, HOME: workspace }, signal: new AbortController().signal });
  } finally { await rm(workspace, { recursive: true }); }
}
const command = (source: string) => ({ argv: [process.execPath, "-e", source] as [string, ...string[]], timeoutSeconds: 5 });

test("Environment deadline invokes command shutdown and observes child completion", () => fixture(async ctx => {
  const runtime = new EnvironmentRuntime(ctx);
  const lifetime = new EnvironmentLifetime(Date.now() + 200, () => runtime.close());
  const pending = runtime.command(command("setInterval(()=>{},1000)"));
  try {
    await lifetime.stopped;
    assert.equal(lifetime.signal.aborted, true);
    assert.equal((await pending).stopReason, "cancelled");
    await assert.rejects(runtime.command(command("")), /ENVIRONMENT_RUNTIME_CLOSING/);
  } finally { await lifetime.close(); }
}));

test("runtime reserves one slot before cwd lookup and releases it after completion", () => fixture(async ctx => {
  const runtime = new EnvironmentRuntime(ctx);
  const first = runtime.command(command("process.stdout.write('first')"));
  await assert.rejects(runtime.command(command("throw Error('must not start')")), /ENVIRONMENT_RUNTIME_BUSY/);
  assert.equal((await first).stdout, "first");
  assert.equal((await runtime.command(command("process.stdout.write('second')"))).stdout, "second");
  await runtime.close();
}));

test("close seals admission synchronously and is idempotent during pending start", () => fixture(async ctx => {
  const runtime = new EnvironmentRuntime(ctx);
  const pending = runtime.command(command("throw Error('must not start')"));
  const stopped = runtime.close();
  assert.equal(runtime.close(), stopped);
  await assert.rejects(runtime.command(command("")), /ENVIRONMENT_RUNTIME_CLOSING/);
  await assert.rejects(pending, /COMMAND_CANCELLED_BEFORE_START/);
  await stopped;
  await assert.rejects(runtime.command(command("")), /ENVIRONMENT_RUNTIME_CLOSING/);
}));

test("invalid command does not permanently occupy the runtime slot", () => fixture(async ctx => {
  const runtime = new EnvironmentRuntime(ctx);
  await assert.rejects(runtime.command({ ...command(""), cwd: ".." }), /COMMAND_CWD_OUTSIDE_WORKSPACE/);
  assert.equal((await runtime.command(command("process.exitCode=3"))).exitCode, 3);
  await runtime.close();
}));

test("close stops an observed live command before resolving", () => fixture(async ctx => {
  const runtime = new EnvironmentRuntime(ctx);
  const watcher = watch(ctx.workspace);
  const ready = new Promise<void>(resolve => watcher.on("change", (_event, file) => {
    if (file === "ready") resolve();
  }));
  const pending = runtime.command(command("process.stdout.write(String(process.pid),()=>require('node:fs').writeFileSync('ready','')); setInterval(()=>{},1000)"));
  try {
    await Promise.race([ready, pending.then(() => { throw new Error("Exited before readiness"); })]);
    await runtime.close();
    const result = await pending;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(result.signal, "SIGKILL");
    // OS readback, not just the fact that abort() returned.
    assert.match(result.stdout, /^[1-9][0-9]*$/);
    assert.throws(() => process.kill(Number(result.stdout), 0), { code: "ESRCH" });
  } finally { watcher.close(); await runtime.close(); }
}));

test("unconfirmed cleanup seals the slot and prevents successful close", t => fixture(async ctx => {
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("controlled failure"), { code: "EPERM" }); });
  const runtime = new EnvironmentRuntime(ctx);
  // The fixture exits by itself; only the post-exit group cleanup is faulted.
  await assert.rejects(runtime.command(command("")), /COMMAND_CLEANUP_UNCONFIRMED/);
  await assert.rejects(runtime.command(command("")), /ENVIRONMENT_RUNTIME_CLOSING/);
  await assert.rejects(runtime.close(), /COMMAND_CLEANUP_UNCONFIRMED/);
}));

test("commands share a workspace, pass literal argv and keep nonzero exit as a result", () => fixture(async ctx => {
  await runCommand(command("require('node:fs').writeFileSync('marker', 'same-workspace')"), ctx);
  const result = await runCommand(command("process.stdout.write(require('node:fs').readFileSync('marker')); process.stderr.write('err'); process.exitCode=7"), ctx);
  assert.equal(result.stdout, "same-workspace");
  assert.equal(result.stderr, "err");
  assert.equal(result.exitCode, 7);
  assert.equal(result.stopReason, undefined);
  const literal = command("process.stdout.write(process.argv[1])");
  literal.argv.push("$(do-not-execute) ; && *");
  assert.equal((await runCommand(literal, ctx)).stdout, "$(do-not-execute) ; && *");
}));

test("command cwd rejects traversal and symlinks outside workspace", () => fixture(async ctx => {
  await symlink(tmpdir(), join(ctx.workspace, "outside"));
  for (const cwd of ["..", "outside"]) {
    await assert.rejects(runCommand({ ...command(""), cwd }, ctx), /COMMAND_CWD_OUTSIDE_WORKSPACE/);
  }
}));

test("command captures bounded output and projects only approved environment fields", () => fixture(async ctx => {
  const env = { ...ctx.env, GH_TOKEN: "approved-fixture", MINI_END_USER_KEY: "private-fixture", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-fixture" };
  const result = await runCommand(command("process.stdout.write(JSON.stringify({gh:process.env.GH_TOKEN, provider:process.env.MINI_END_USER_KEY, oidc:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}))"), { ...ctx, env });
  assert.deepEqual(JSON.parse(result.stdout), { gh: "approved-fixture" });
  const large = await runCommand(command("process.stdout.write('a'.repeat(100000));process.stderr.write('b'.repeat(100000))"), ctx);
  assert.equal(Buffer.byteLength(large.stdout + large.stderr), 65536);
  assert.equal(large.truncated, true);
  const binary = await runCommand(command("process.stdout.write(Buffer.alloc(65536,255))"), ctx);
  assert.ok(Buffer.byteLength(binary.stdout + binary.stderr) <= 65536);
  assert.equal(binary.truncated, true);
}));

test("pre-start cancellation and expired deadline do not launch commands", () => fixture(async ctx => {
  await assert.rejects(runCommand(command("throw Error('must not start')"), { ...ctx, signal: AbortSignal.abort() }), /COMMAND_CANCELLED_BEFORE_START/);
  await assert.rejects(runCommand(command(""), { ...ctx, deadline: Date.now() - 1 }), /COMMAND_DEADLINE_EXPIRED/);
}));

test("Environment deadline caps a longer command timeout and stays expired for later commands", () => fixture(async ctx => {
  const runtime = new EnvironmentRuntime({ ...ctx, deadline: Date.now() + 200 });
  try {
    const result = await runtime.command(command("setInterval(()=>{},1000)"));
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.signal, "SIGKILL");
    // Reusing the runtime must not allocate a fresh execution budget.
    await assert.rejects(runtime.command(command("throw Error('must not start')")), /COMMAND_DEADLINE_EXPIRED/);
  } finally { await runtime.close(); }
}));

test("timeout and cancellation return only after process close", () => fixture(async ctx => {
  const timeout = await runCommand({ ...command("setInterval(()=>{},1000)"), timeoutSeconds: 0.1 }, ctx);
  assert.equal(timeout.stopReason, "timeout");
  assert.equal(timeout.signal, "SIGKILL");
  assert.equal(timeout.exitCode, null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const cancelled = await runCommand(command("setInterval(()=>{},1000)"), { ...ctx, signal: controller.signal });
    assert.equal(cancelled.stopReason, "cancelled");
    assert.equal(cancelled.signal, "SIGKILL");
  } finally { clearTimeout(timer); }
  await assert.rejects(runCommand({ argv: [join(ctx.workspace, "missing")], timeoutSeconds: 1 }, ctx), /COMMAND_EXECUTION_FAILED/);
}));
