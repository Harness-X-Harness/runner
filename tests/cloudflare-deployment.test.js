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
    undefined,
  );
  assert.deepEqual(configuration.migrations.find(({ tag }) => tag === "v4"), {
    tag: "v4",
    deleted_classes: ["TaskObject"],
  });
  assert.deepEqual(configuration.migrations.at(-1), {
    tag: "v6", deleted_classes: ["EnvironmentObject"],
  });
  assert.deepEqual(configuration.durable_objects.bindings.find(({ name }) => name === "TASKS"),
    { name: "TASKS", class_name: "TaskRuntimeObject" });
  assert.equal(
    configuration.vars.GITHUB_ENVIRONMENT_WORKFLOW_ID,
    undefined,
  );
  assert.equal(configuration.vars.GITHUB_WORKFLOW_ID, undefined);
  assert.equal(configuration.vars.LEGACY_DRAIN_MODE, undefined);
  assert.deepEqual(configuration.durable_objects.bindings.map(({name}) => name).sort(), ["AUTHORIZATION_STATES", "TASKS"]);
});
