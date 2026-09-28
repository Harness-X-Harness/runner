import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentAdmission } from "../apps/chatgpt-app/src/environment-admission.ts";
import { taskStorage } from "./helpers/task-storage.ts";

const id = (value: number) => `env_${value.toString(16).padStart(32, "0")}`;
const deadline = Date.now() + 60000;

test("concurrent owner admission commits exactly one reservation and duplicate delivery is stable", async () => {
  const storage = taskStorage();
  const admission = new EnvironmentAdmission(storage);
  const results = await Promise.allSettled([admission.reserve("1", id(1), deadline), admission.reserve("1", id(2), deadline)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.deepEqual(await admission.list("1"), [id(1)]);
  await new EnvironmentAdmission(storage).reserve("1", id(1), deadline);
  assert.deepEqual(await admission.list("2"), []);
  await assert.rejects(admission.list(""), /INVALID_ENVIRONMENT_OWNER/);
  await assert.rejects(admission.list("01"), /INVALID_ENVIRONMENT_OWNER/);
  await assert.rejects(admission.reserve("2", id(1), deadline), /OWNER_MISMATCH/);
});

test("global admission rejects a fifth owner; confirmed release cannot be revived by late reserve", async () => {
  const admission = new EnvironmentAdmission(taskStorage());
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => admission.reserve(String(n + 1), id(n + 1), deadline)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 4);
  await assert.rejects(admission.reserve("5", id(5), deadline), /GLOBAL_CAPACITY/);
  // Close intent has no release API: keep the reservation until evidence exists.
  await assert.rejects(admission.reserve("1", id(6), deadline), /OWNER_CAPACITY/);
  await assert.rejects(admission.releaseConfirmed("2", id(1)), /NOT_FOUND/);
  await admission.releaseConfirmed("1", id(1));
  await admission.releaseConfirmed("1", id(1));
  await assert.rejects(admission.reserve("1", id(1), deadline), /RESERVATION_RELEASED/);
  await admission.reserve("5", id(5), deadline);
  assert.deepEqual(await admission.list("1"), []);
  assert.deepEqual(await admission.list("5"), [id(5)]);
});

test("expired released receipts are collected but held reservations never expire implicitly", async () => {
  let now = 100;
  const storage = taskStorage();
  const admission = new EnvironmentAdmission(storage, () => now);
  await admission.reserve("1", id(1), 200);
  await admission.reserve("2", id(2), 200);
  await assert.rejects(admission.reserve("1", id(1), 201), /ADMISSION_CONFLICT/);
  await admission.releaseConfirmed("1", id(1));
  now = 200;
  await admission.reserve("3", id(3), 300);
  await assert.rejects(admission.reserve("1", id(1), 200), /ADMISSION_EXPIRED/);
  assert.deepEqual(await admission.list("2"), [id(2)]);
  const stored = await storage.get<Array<{ environmentId: string }>>("environment-admission");
  assert.deepEqual(stored?.map(record => record.environmentId), [id(2), id(3)]);
  await admission.releaseConfirmed("1", id(1));
  assert.deepEqual(await admission.list("2"), [id(2)]);
});

test("receipt capacity refuses new admission rather than dropping replay protection", async () => {
  const admission = new EnvironmentAdmission(taskStorage(), () => 100);
  for (let n = 1; n <= 256; n++) {
    await admission.reserve("1", id(n), 200);
    await admission.releaseConfirmed("1", id(n));
  }
  await assert.rejects(admission.reserve("1", id(257), 200), /RECEIPT_CAPACITY/);
  await assert.rejects(admission.reserve("1", id(1), 200), /RESERVATION_RELEASED/);
});
