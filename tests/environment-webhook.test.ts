import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "../apps/chatgpt-app/node_modules/@octokit/webhooks-methods/dist-node/index.js";
import { environmentWebhook } from "../apps/chatgpt-app/src/environment-webhook.ts";

const secret = "local-test-only-not-a-deployed-secret";
const environmentId = `env_${"a".repeat(32)}`;
const repository = { full_name: "fixture/runner" };
const event = { action: "completed", repository, workflow_run: {
  id: 42, run_attempt: 1, display_title: environmentId, actor: { id: 7 }, repository,
  path: ".github/workflows/run-environment.yml", status: "completed", conclusion: "success",
} };
const request = async (value: unknown, key = secret, type = "workflow_run") => {
  const body = JSON.stringify(value);
  return new Request("https://fixture/github/events", { method: "POST", body,
    headers: { "x-github-event": type, "x-hub-signature-256": await sign(key, body) } });
};

test("signed completion targets only the existing exact Environment execution", async () => {
  const received: unknown[] = [];
  const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_RUNNER_REPOSITORY: repository.full_name,
    ENVIRONMENT_ADMISSION: { getByName() { return { async held(): Promise<never> { throw new Error("unexpected CI routing"); } }; } },
    ENVIRONMENTS: { getByName(name: string) {
      assert.equal(name, environmentId);
      return { async confirmExecutionStopped(value: unknown): Promise<"closed"> { received.push(value); return "closed"; },
        async completeGithubWaits(): Promise<never> { throw new Error("unexpected CI completion"); } };
    } } };
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await environmentWebhook(await request(event), env)).status, 204);
  assert.deepEqual(received, Array(2).fill({ ownerId: "7", repository: repository.full_name, runId: "42", runAttempt: "1" }));
  assert.equal((await environmentWebhook(await request(event, "wrong-secret"), env)).status, 401);
  for (const value of [
    { ...event, action: "requested" },
    { ...event, repository: { full_name: "other/repository" } },
    { ...event, workflow_run: { ...event.workflow_run, path: ".github/workflows/other.yml" } },
  ]) assert.equal((await environmentWebhook(await request(value), env)).status, 202);
  for (const change of [{ status: "in_progress" }, { conclusion: null }, { run_attempt: 0 },
    { display_title: "../other" }, { repository: { full_name: "other/repository" } }]) {
    assert.equal((await environmentWebhook(await request({ ...event, workflow_run: { ...event.workflow_run, ...change } }), env)).status, 400);
  }
  assert.equal(received.length, 2);
});

test("failed durable delivery is not acknowledged and does not expose exceptions", async () => {
  const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_RUNNER_REPOSITORY: repository.full_name,
    ENVIRONMENT_ADMISSION: { getByName() { return { async held(): Promise<never> { throw new Error("unexpected CI routing"); } }; } },
    ENVIRONMENTS: { getByName() { return { async confirmExecutionStopped(): Promise<never> {
      throw new Error("PRIVATE_STORAGE_DETAIL");
    }, async completeGithubWaits(): Promise<never> { throw new Error("unexpected CI completion"); } }; } } };
  const response = await environmentWebhook(await request(event), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
  assert.equal((await environmentWebhook(await request(event), { ...env, GITHUB_WEBHOOK_SECRET: "" })).status, 503);
});

test("covered CI completion routes only to held Environments and acknowledges durable delivery", async () => {
  const delivered: unknown[] = [];
  const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_RUNNER_REPOSITORY: repository.full_name,
    GITHUB_CI_EVENT_REPOSITORIES: JSON.stringify([repository.full_name]),
    ENVIRONMENT_ADMISSION: { getByName(name: string) {
      assert.equal(name, "global"); return { async held() { return [environmentId]; } };
    } },
    ENVIRONMENTS: { getByName(name: string) {
      assert.equal(name, environmentId); return {
        async confirmExecutionStopped(): Promise<never> { throw new Error("CI is not an Environment execution"); },
        async completeGithubWaits(value: unknown) { delivered.push(value); return 1; },
      };
    } } };
  const ci = { ...event, workflow_run: { ...event.workflow_run,
    path: ".github/workflows/ci.yml", head_sha: "a".repeat(40), display_title: "ordinary CI" } };
  assert.equal((await environmentWebhook(await request(ci), env)).status, 204);
  assert.deepEqual(delivered, [{ repository: repository.full_name, runId: "42", runAttempt: 1,
    revision: "a".repeat(40), conclusion: "success" }]);
  assert.equal((await environmentWebhook(await request(ci, "wrong"), env)).status, 401);
  assert.equal((await environmentWebhook(await request(ci), { ...env, GITHUB_CI_EVENT_REPOSITORIES: "[]" })).status, 202);
  assert.equal((await environmentWebhook(await request({ ...ci, workflow_run: { ...ci.workflow_run, head_sha: "invalid" } }), env)).status, 400);
  assert.equal(delivered.length, 1);
  const failed = { ...env, ENVIRONMENT_ADMISSION: { getByName() { return { async held(): Promise<never> { throw new Error("PRIVATE"); } }; } } };
  const response = await environmentWebhook(await request(ci), failed);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
});
