import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentCreation } from "../apps/chatgpt-app/src/environment-creation.ts";
import { EnvironmentAdmission } from "../apps/chatgpt-app/src/environment-admission.ts";
import { taskStorage } from "./helpers/task-storage.ts";

const input = { ownerId: "1", environmentId: `env_${"a".repeat(32)}`, executor: "codex" };

test("creation retries and changed startup policy cannot refresh an Environment deadline", async () => {
  const storage = taskStorage();
  const creation = new EnvironmentCreation(storage, 100, () => 100);
  const original = await creation.create(input);
  assert.equal(original.admitUntil, 200);
  const restarted = new EnvironmentCreation(storage, 1000, () => 300);
  assert.deepEqual(await restarted.create(input), original);
  assert.deepEqual(await restarted.read("1"), original);
  await assert.rejects(restarted.read("2"), /NOT_FOUND/);
  await assert.rejects(restarted.create({ ...input, admitUntil: 2000 }));
  const admission = new EnvironmentAdmission(taskStorage(), () => 300);
  const record = await restarted.read("1");
  await assert.rejects(admission.reserve(record.ownerId, record.environmentId, record.admitUntil), /ADMISSION_EXPIRED/);
});

test("concurrent conflicting creates cannot change owner or executor", async () => {
  const creation = new EnvironmentCreation(taskStorage(), 100, () => 100);
  const results = await Promise.allSettled([
    creation.create(input), creation.create({ ...input, executor: "grok" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await creation.read("1")).executor, "codex");
  await assert.rejects(creation.create({ ...input, ownerId: "2" }), /CREATION_CONFLICT/);
});
