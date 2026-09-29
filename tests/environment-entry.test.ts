import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimEnvironment } from "../.github/actions/agent-runtime/environment-entry.ts";
import { agentEnvironment, configureProvider } from "../.github/actions/agent-runtime/provider-config.ts";

test("provider configuration stays private and Agent child does not inherit job authority", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-provider-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { HOME: directory, GH_TOKEN: "PRIVATE_AGENT_TOKEN", MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY",
    MINI_CODEX_BASE_URL: "https://codex.example", MINI_GROK_BASE_URL: "https://grok.example",
    GITHUB_TOKEN: "PRIVATE_JOB_TOKEN", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "PRIVATE_OIDC",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example" };
  for (const executor of ["codex", "grok"] as const) {
    await configureProvider(executor, env);
    const file = join(directory, `.${executor}`, "config.toml");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const config = await readFile(file, "utf8");
    if (executor === "codex") {
      assert.match(config, /env_key = "MINI_END_USER_KEY"/);
      assert.match(config, /model = "gpt-6-sol"\nmodel_reasoning_effort = "high"/);
    } else {
      assert.match(config, /default_reasoning_effort = "xhigh"/);
      assert.match(config, /default = "grok-4.7"/);
      assert.match(config, /\[endpoints\]\nmodels_base_url = "https:\/\/grok.example"/);
      assert.match(config, /\[model\."grok-4.7"\]\nenv_key = "MINI_END_USER_KEY"/);
      assert.doesNotMatch(config, /mini-agent/);
    }
    assert.doesNotMatch(config, /PRIVATE_/);
  }
  const child = agentEnvironment(env);
  assert.equal(child.GH_TOKEN, env.GH_TOKEN);
  assert.equal(child.MINI_END_USER_KEY, env.MINI_END_USER_KEY);
  for (const key of ["GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"]) {
    assert.equal(child[key], undefined);
    assert.ok(env[key as keyof typeof env]);
  }
});

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
