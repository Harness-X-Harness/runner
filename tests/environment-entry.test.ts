import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimEnvironment } from "../.github/actions/agent-runtime/environment-entry.ts";

test("Environment bootstrap stores only executor/deadline privately and outputs only executor", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-environment-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentId = `env_${"a".repeat(32)}`;
  const env = { ENVIRONMENT_ID: environmentId, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "outputs"),
    TASK_CONTROL_PLANE_URL: "https://control.example", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "PRIVATE_OIDC_REQUEST", GITHUB_TOKEN: "PRIVATE_JOB_TOKEN" };
  const deadline = Date.now() + 60000;
  let stop = true;
  const fetchImpl: typeof fetch = async input => new URL(String(input)).hostname === "oidc.example"
    ? Response.json({ value: "PRIVATE_OIDC_ASSERTION" })
    : Response.json(stop ? { decision: "stop" } : { decision: "bound", executor: "grok", deadline });
  await claimEnvironment(env, fetchImpl);
  await assert.rejects(stat(join(directory, `harness-${environmentId}`)), { code: "ENOENT" });
  stop = false;
  await claimEnvironment(env, fetchImpl);
  const file = join(directory, `harness-${environmentId}`, "claim.json");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { executor: "grok", deadline });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "executor=grok\n");
});
