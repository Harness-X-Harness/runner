import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentInput } from "../.github/actions/agent-runtime/environment-input.ts";

const form = { sessionId: "session", mode: "form" as const, message: "Choose a name",
  requestedSchema: { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"] } };

test("native form remains pending until a schema-valid, exact-task answer and replays duplicate answers", async () => {
  let changes = 0;
  const inputs = new EnvironmentInput();
  inputs.subscribe(() => changes++);
  const waiting = inputs.request("task-one", form);
  const [pending] = inputs.pending("task-one");
  assert.ok(pending);
  assert.equal(pending.request.method, "elicitation/create");
  assert.equal(changes, 1);
  assert.deepEqual(inputs.pending("other"), []);
  assert.throws(() => inputs.answer("other", pending.inputId, { action: "accept", content: { name: "Ada" } }), /INPUT_NOT_FOUND/);
  assert.throws(() => inputs.answer("task-one", pending.inputId, { action: "accept", content: { name: 123 } }));
  assert.equal(inputs.pending("task-one").length, 1);
  const answer = { action: "accept", content: { name: "Ada" } };
  inputs.answer("task-one", pending.inputId, answer);
  assert.deepEqual(await waiting, answer);
  inputs.answer("task-one", pending.inputId, answer);
  assert.equal(changes, 2);
  assert.throws(() => inputs.answer("task-one", pending.inputId, { action: "cancel" }), /INPUT_RESPONSE_CONFLICT/);
  assert.deepEqual(inputs.pending("task-one"), []);
});

test("cancellation answers all outstanding native forms without affecting a different task", async () => {
  const inputs = new EnvironmentInput();
  const one = inputs.request("one", form);
  const two = inputs.request("one", form);
  const other = inputs.request("two", form);
  inputs.cancel("one");
  assert.deepEqual(await Promise.all([one, two]), [{ action: "cancel" }, { action: "cancel" }]);
  assert.equal(inputs.pending("two").length, 1);
  inputs.cancel("two");
  assert.deepEqual(await other, { action: "cancel" });
});
