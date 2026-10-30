import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagingConfig, type ProductionConfig } from "./helpers/t3-staging.ts";

const require = createRequire(new URL("../apps/chatgpt-app/package.json", import.meta.url));
const { unstable_readConfig } = require("wrangler") as {
  unstable_readConfig(input: { config: string }): ProductionConfig;
};
const production = unstable_readConfig({ config: fileURLToPath(new URL("../apps/chatgpt-app/wrangler.jsonc", import.meta.url)) });
const manifest = {
  accountId: "a".repeat(32), workerName: "runner-staging-pr229", origin: "https://runner-staging.example.org",
  oauthKvId: "b".repeat(32), githubAppClientId: "Iv1StagingFixture",
  executionRepository: "fixture/runner-staging", runtimeBranch: "staging/pr229", runtimeRevision: "c".repeat(40),
};

test("offline staging config creates independent state, routing, OAuth and execution authority", () => {
  const config = stagingConfig(manifest, production);
  assert.equal(config.name, manifest.workerName);
  assert.deepEqual(config.routes, [{ pattern: "runner-staging.example.org", custom_domain: true }]);
  assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV", id: manifest.oauthKvId }]);
  assert.deepEqual(config.durable_objects.bindings, production.durable_objects.bindings);
  assert.deepEqual(config.migrations, [{ tag: "staging-v1",
    new_sqlite_classes: production.durable_objects.bindings.map(binding => binding.class_name) }]);
  assert.equal(config.vars.GITHUB_RUNNER_REPOSITORY, manifest.executionRepository);
  assert.equal(config.vars.GITHUB_RUNNER_REF, manifest.runtimeBranch);
  assert.equal(config.vars.GITHUB_CI_EVENT_REPOSITORIES, JSON.stringify([manifest.executionRepository]));
  assert.equal(config.vars.GITHUB_APP_CLIENT_ID, manifest.githubAppClientId);
  assert.equal(config.vars.TASK_CONTROL_PLANE_URL, manifest.origin);
  assert.equal(config.observability.enabled, false);
  assert.equal("env" in config || "services" in config || "unsafe" in config, false);
});

test("staging preparation rejects shared production resources, ambiguous URLs and secret-bearing manifests", () => {
  for (const patch of [
    { workerName: production.name }, { oauthKvId: production.kv_namespaces[0]!.id },
    { githubAppClientId: production.vars.GITHUB_APP_CLIENT_ID },
    { executionRepository: String(production.vars.GITHUB_RUNNER_REPOSITORY).toUpperCase() },
    ...[String(production.vars.TASK_CONTROL_PLANE_URL), "https://user:PRIVATE_KEY@staging.example.org",
      "https://staging.example.org/?code=PRIVATE_CODE", "https://staging.example.org/#PRIVATE_PAIRING",
      "https://staging.example.org/", "http://staging.example.org", "https://127.0.0.1",
      "https://runners.trustedtunnel.app.", "https://nested.runners.trustedtunnel.app"].map(origin => ({ origin })),
    { GITHUB_APP_CLIENT_SECRET: "PRIVATE_SECRET" }, { runtimeRevision: "main" },
    { runtimeBranch: "refs/heads/main" }, { runtimeBranch: "a//b" }, { accountId: "" },
  ]) assert.throws(() => stagingConfig({ ...manifest, ...patch }, production),
    /^Error: T3_STAGING_MANIFEST_INVALID_OR_SHARED$/);
  assert.throws(() => stagingConfig(manifest, { ...production, durable_objects: {
    bindings: [{ name: "ENVIRONMENTS", class_name: "BoundedEnvironmentObject", script_name: production.name }],
  } }), /^Error: T3_STAGING_EXTERNAL_DO_BINDING_REJECTED$/);
});

test("staging CLI fails closed without echoing sensitive file arguments", () => {
  const script = fileURLToPath(new URL("prepare-t3-staging.ts", import.meta.url));
  const child = spawnSync(process.execPath, [script, "/nonexistent/PRIVATE_SECRET.json"], {
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "T3_STAGING_PREPARATION_FAILED\n");
});

test("staging CLI emits only a standalone config and suppresses malformed or secret-bearing input", async t => {
  const root = await mkdtemp(join(tmpdir(), "staging-manifest-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const input = join(root, "manifest.json");
  const script = fileURLToPath(new URL("prepare-t3-staging.ts", import.meta.url));
  const run = () => spawnSync(process.execPath, [script,input], {
    env:{PATH:process.env.PATH, HOME:root, WRANGLER_SEND_METRICS:"false"}, encoding:"utf8",
  });
  await writeFile(input, JSON.stringify(manifest));
  const prepared = run();
  assert.equal(prepared.status, 0);
  assert.deepEqual(JSON.parse(prepared.stdout), stagingConfig(manifest, production));
  assert.match(prepared.stderr, /^OFFLINE CONFIG ONLY:/);
  for (const content of ["{PRIVATE_SECRET", JSON.stringify({...manifest,secret:"PRIVATE_SECRET"})]) {
    await writeFile(input, content);
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, "T3_STAGING_PREPARATION_FAILED\n");
  }
});
