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
    assert.ok(source.includes('env_key = "MINI_END_USER_KEY"'));
    assert.ok(source.includes("> /dev/null"));
    if (provider === "codex") {
      assert.ok(source.includes("https://chatgpt.com/codex/install.sh"));
      assert.ok(source.includes("codex exec --ephemeral --skip-git-repo-check --sandbox read-only"));
    } else {
      assert.ok(source.includes("https://x.ai/cli/install.sh"));
      assert.ok(source.includes("grok --no-auto-update --always-approve -m mini-grok-4-6"));
    }
  });
}

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
