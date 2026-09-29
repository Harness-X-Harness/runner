import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";

test("control plane uses one fixed Custom Domain without workers.dev", async () => {
  // wrangler.jsonc uses full-line comments. Do not treat // inside values as comments.
  const source = (await readFile(new URL("../apps/chatgpt-app/wrangler.jsonc", import.meta.url), "utf8"))
    .replace(/^\s*\/\/.*$/gm, "");
  const configuration = z.object({
    workers_dev: z.boolean(), preview_urls: z.boolean(),
    routes: z.array(z.looseObject({ pattern: z.string(), custom_domain: z.boolean() })),
    vars: z.record(z.string(), z.unknown()),
    durable_objects: z.object({ bindings: z.array(z.looseObject({ name: z.string(), class_name: z.string() })) }),
    migrations: z.array(z.looseObject({ tag: z.string() })),
  }).parse(JSON.parse(source));

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
    { name: "ENVIRONMENTS", class_name: "BoundedEnvironmentObject" },
  );
  assert.deepEqual(configuration.migrations.find(({ tag }) => tag === "v4"), {
    tag: "v4",
    deleted_classes: ["TaskObject"],
  });
  assert.deepEqual(configuration.migrations.find(({ tag }) => tag === "v6"), {
    tag: "v6", deleted_classes: ["EnvironmentObject"],
  });
  assert.deepEqual(configuration.migrations.at(-1), {
    tag: "v8", deleted_classes: ["TaskRuntimeObject"],
  });
  assert.equal(configuration.durable_objects.bindings.find(({ name }) => name === "TASKS"), undefined);
  assert.equal(
    configuration.vars.GITHUB_ENVIRONMENT_WORKFLOW_ID,
    undefined,
  );
  assert.equal(configuration.vars.GITHUB_WORKFLOW_ID, undefined);
  assert.equal(configuration.vars.LEGACY_DRAIN_MODE, undefined);
  assert.deepEqual(configuration.durable_objects.bindings.map(({name}) => name).sort(),
    ["AUTHORIZATION_STATES", "ENVIRONMENTS", "ENVIRONMENT_ADMISSION"]);
  assert.equal(configuration.vars.ENVIRONMENT_STARTUP_MS, 600000);
});
