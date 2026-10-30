import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readT3Descriptor } from "../.github/actions/agent-runtime/t3-readiness.ts";
import { liveOrigin, privateT3Json, requireTrustedModelContext, jsonObject, verifyModelRun } from "./helpers/t3-live.ts";

test("an installed T3 exposes matching local/public identity and real CLI state", {
  skip: process.env.T3_LIVE !== "1" && "Requires T3_LIVE=1 and a running T3 server",
  timeout: 90_000,
}, async () => {
  const local = liveOrigin(process.env.T3_LOCAL_ORIGIN || "http://127.0.0.1:3773");
  const origin = liveOrigin(process.env.T3_LIVE_ORIGIN || local);
  const signal = AbortSignal.timeout(15_000);
  const expected = await readT3Descriptor(local, signal);
  const actual = await readT3Descriptor(origin, signal);
  assert.ok(expected && actual, "native descriptors must be reachable");
  assert.ok(expected.environmentId === actual.environmentId && expected.serverVersion === actual.serverVersion,
    "public transport must reach the local T3 identity/version");
  const result = await privateT3Json(["thread", "list", "--json"], {
    cwd: process.env.T3_LIVE_PROJECT || process.cwd(),
  });
  assert.ok(result.exitCode === 0 && typeof result.value === "object" && result.value !== null);
});

test("an explicitly selected provider completes a real T3 run and authoritative terminal state", {
  skip: process.env.T3_LIVE_MODEL !== "1" && "Requires explicit trusted paid-model opt-in",
  timeout: 180_000,
}, async () => {
  requireTrustedModelContext(process.env);
  const marker = "T3_LIVE_" + randomUUID().replaceAll("-", "");
  const result = await privateT3Json(["thread", "start", process.env.T3_LIVE_PROJECT!,
    `Reply with exactly ${marker}. Do not call tools, read credentials, or modify files.`,
    "--provider", process.env.T3_LIVE_PROVIDER!, "--model", process.env.T3_LIVE_MODEL_ID!, "--wait", "--json"],
  { timeoutMs: 120_000 });
  const run = jsonObject(result.value);
  if (typeof run.threadId !== "string") throw new Error("T3_LIVE_THREAD_ID_MISSING");
  const shown = await privateT3Json(["thread", "show", run.threadId, "--json"]);
  assert.ok(shown.exitCode === 0, "authoritative native state must be readable");
  verifyModelRun(run, shown.value, process.env.T3_LIVE_PROVIDER!, process.env.T3_LIVE_MODEL_ID!, marker);
  assert.ok(result.exitCode === 0, "completed run must have native success exit code");
});
