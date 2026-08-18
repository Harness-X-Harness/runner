import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("control plane uses one fixed Custom Domain without workers.dev", async () => {
  const configuration = JSON.parse(
    await readFile(
      new URL("../apps/chatgpt-app/wrangler.jsonc", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(configuration.workers_dev, false);
  assert.equal(configuration.preview_urls, false);
  assert.deepEqual(configuration.routes, [
    {
      pattern: "runners.trustedtunnel.app",
      custom_domain: true,
    },
  ]);
  assert.equal(
    configuration.vars.TASK_CONTROL_PLANE_URL,
    "https://runners.trustedtunnel.app",
  );
  assert.deepEqual(
    configuration.durable_objects.bindings.find(({ name }) => name === "ENVIRONMENTS"),
    { name: "ENVIRONMENTS", class_name: "EnvironmentObject" },
  );
  assert.deepEqual(configuration.migrations.at(-1), {
    tag: "v4",
    deleted_classes: ["TaskObject"],
  });
  assert.equal(
    configuration.durable_objects.bindings.some(({ name }) => name === "TASKS"),
    false,
  );
  assert.equal(
    configuration.vars.GITHUB_ENVIRONMENT_WORKFLOW_ID,
    "private-runner-session.yml",
  );
  assert.equal(configuration.vars.GITHUB_WORKFLOW_ID, undefined);
});
