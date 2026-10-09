import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "../apps/chatgpt-app/node_modules/yaml/dist/index.js";
import { z } from "../.github/actions/agent-runtime/node_modules/zod/index.js";

const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
});
const workflow = (name: string) => readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");

for (const provider of ["codex", "grok"] as const) {
  test(`${provider} auth probe is explicit, read-only, and uses private native configuration`, async () => {
    const source = await workflow(`${provider}-auth`);
    const parsed = workflowSchema.parse(parse(source));
    assert.deepEqual(Object.keys(parsed.on).sort(), ["schedule", "workflow_dispatch"]);
    assert.deepEqual(parsed.permissions, { contents: "read" });
    assert.match(source, /secrets\.MINI_END_USER_KEY/);
    assert.ok(source.includes(`secrets.MINI_${provider.toUpperCase()}_BASE_URL`));
    assert.ok(source.includes(`node .github/actions/agent-runtime/auth-probe.ts ${provider}`));
    assert.doesNotMatch(source, /AGENT_GITHUB_TOKEN|GH_TOKEN|config\.toml|mini-agent/);
    if (provider === "codex") {
      assert.ok(source.includes("https://chatgpt.com/codex/install.sh"));
    } else {
      assert.ok(source.includes("https://x.ai/cli/install.sh"));
    }
  });
}

test("Codex Linux sandbox preparation is scoped, credential-free and fail-closed", async () => {
  type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };
  const environmentWorkflow = parse(await workflow("run-environment")) as {
    jobs: { environment: { steps: Step[] } };
  };
  const ciWorkflow = parse(await workflow("test")) as {
    jobs: { "codex-sandbox": { "runs-on": string; permissions: Record<string, string>; steps: Step[] } };
  };
  const steps = environmentWorkflow.jobs.environment.steps;
  const position = (name: string) => steps.findIndex(step => step.name === name);
  const ordered = [
    "Claim Environment", "Prepare Codex sandbox", "Install Codex",
    "Verify Codex sandbox", "Serve Environment",
  ].map(position);
  assert.ok(ordered[0]! >= 0);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i]! > ordered[i - 1]!, "Codex sandbox gate must precede credentials");
  }

  const setup = steps[position("Prepare Codex sandbox")]!;
  const probe = steps[position("Verify Codex sandbox")]!;
  for (const step of [setup, probe]) {
    assert.equal(step.if, "steps.claim.outputs.executor == 'codex'");
    assert.equal(step.env, undefined);
    assert.match(step.run ?? "", /set -euo pipefail/);
  }
  assert.ok(setup.run!.includes("sudo apt-get install --yes --no-install-recommends bubblewrap apparmor-profiles"));
  assert.ok(setup.run!.includes("sudo apparmor_parser -r /usr/share/apparmor/extra-profiles/bwrap-userns-restrict"));
  assert.ok(probe.run!.includes("bwrap --unshare-user --unshare-net --ro-bind / / -- /usr/bin/true"));
  assert.ok(probe.run!.includes("codex sandbox -- /usr/bin/true"));
  assert.doesNotMatch(setup.run! + probe.run!, /\bsysctl\b|setcap|--share-net|--dangerously-bypass/);
  assert.doesNotMatch(probe.run!, /\bsudo\b|MINI_END_USER_KEY|AGENT_GITHUB_TOKEN/);
  assert.doesNotMatch(JSON.stringify(steps.slice(0, position("Serve Environment"))), /secrets\./);

  const ci = ciWorkflow.jobs["codex-sandbox"];
  assert.equal(ci["runs-on"], "ubuntu-24.04");
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.deepEqual(ci.steps.map(step => step.name), [
    "Check out repository", "Prepare Codex sandbox", "Install Codex", "Verify Codex sandbox",
  ]);
  assert.equal(ci.steps[1]!.run, setup.run);
  assert.equal(ci.steps[3]!.run, probe.run);
  assert.equal(ci.steps[2]!.run, steps[position("Install Codex")]!.run);
  assert.doesNotMatch(JSON.stringify(ci), /secrets\.|MINI_END_USER_KEY|AGENT_GITHUB_TOKEN/);
});

test("public workflow sources do not persist executor credentials or publish private Task data", async () => {
  const sources = await Promise.all(["run-environment", "codex-auth", "grok-auth"].map(workflow));
  for (const source of sources) {
    assert.doesNotMatch(source, /experimental_bearer_token|auth[.]json|api_key\s*=/);
  }
  sources.push(await readFile(new URL("../.github/actions/agent-runtime/provider-config.ts", import.meta.url), "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /GITHUB_STEP_SUMMARY|actions\/upload-artifact|set -x/);
  }
});
