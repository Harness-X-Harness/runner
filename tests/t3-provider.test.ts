import assert from "node:assert/strict";
import test from "node:test";
import { t3ProviderEnvironment } from "../.github/actions/agent-runtime/t3-provider.ts";

test("T3 consumes existing provider configuration without inheriting job control authority", () => {
  const source = {
    HOME: "/tmp/runner", PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "en_US.UTF-8",
    MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY",
    MINI_CODEX_BASE_URL: "https://provider.example/codex",
    MINI_GROK_BASE_URL: "https://provider.example/grok",
    GH_TOKEN: "PRIVATE_WORK_TOKEN", GITHUB_TOKEN: "PRIVATE_JOB_TOKEN",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "PRIVATE_OIDC",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
    TASK_CONTROL_PLANE_URL: "https://control.example",
  };
  for (const executor of ["codex", "grok"] as const) {
    const child = t3ProviderEnvironment(executor, source);
    assert.equal(child.MINI_END_USER_KEY, source.MINI_END_USER_KEY);
    assert.equal(child.GH_TOKEN, source.GH_TOKEN);
    assert.equal(child.XAI_API_KEY, executor === "grok" ? source.MINI_END_USER_KEY : undefined);
    assert.ok(child.PATH?.startsWith("/tmp/runner/.local/bin:"));
    assert.ok(child.PATH?.includes("/tmp/runner/.grok/bin"));
    for (const key of ["GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL", "TASK_CONTROL_PLANE_URL"]) {
      assert.equal(child[key], undefined);
    }
    assert.ok(!JSON.stringify(child).includes("PRIVATE_JOB_TOKEN"));
  }
  assert.throws(() => t3ProviderEnvironment("codex", { HOME: "/tmp", MINI_END_USER_KEY: "value" }),
    /T3_PROVIDER_UNAVAILABLE/);
  assert.throws(() => t3ProviderEnvironment("grok", { ...source, HOME: "relative" }),
    /T3_PROVIDER_UNAVAILABLE/);
});
