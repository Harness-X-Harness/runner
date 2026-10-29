import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execute = promisify(execFile);
const enabled = process.env.T3_LIVE === "1";

test("an installed, unmodified T3 serves HTTP and exposes real CLI thread state", {
  skip: !enabled && "Requires T3_LIVE=1 and a running T3 server",
  timeout: 90_000,
}, async () => {
  const origin = process.env.T3_LIVE_ORIGIN || "http://127.0.0.1:3773";
  const url = new URL(origin);
  assert.ok(["http:", "https:"].includes(url.protocol));
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.ok, true, "T3 HTTP readiness must be verified, not mocked");
  await response.body?.cancel();
  const project = process.env.T3_LIVE_PROJECT || process.cwd();
  const { stdout } = await execute("t3", ["thread", "list", "--json"], { timeout: 20_000, cwd: project });
  assert.ok(stdout.length > 0);
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test("a real provider runs through T3 rather than the Runner's ACP Agent", {
  skip: process.env.T3_LIVE_MODEL !== "1" && "Requires explicit T3_LIVE_MODEL=1 with provider auth",
  timeout: 180_000,
}, async () => {
  assert.equal(process.env.T3_LIVE, "1", "Live model proof needs T3 service proof");
  const project = process.env.T3_LIVE_PROJECT;
  assert.ok(project, "T3_LIVE_PROJECT must name the disposable project");
  const message = "Return the exact word T3_LIVE_OK and do not modify files.";
  const { stdout } = await execute("t3", ["thread", "start", project!, message, "--json"], { timeout: 120_000 });
  const data: unknown = JSON.parse(stdout);
  assert.ok(typeof data === "object" && data !== null && "threadId" in data &&
    typeof data.threadId === "string", "must return an authoritative T3 thread ID");
  const { stdout: reply } = await execute("t3",
    ["thread", "send", data.threadId as string, "Reply exactly T3_LIVE_OK.", "--wait"],
    { timeout: 120_000 });
  assert.match(reply, /T3_LIVE_OK/, "must receive a real T3 provider reply, not just a thread identifier");
  const { stdout: result } = await execute("t3", ["thread", "show", data.threadId as string, "--json"],
    { timeout: 20_000 });
  const parsed: unknown = JSON.parse(result);
  assert.ok(typeof parsed === "object" && parsed !== null && "thread" in parsed,
    "must read authoritative T3 thread state");
});
