import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  codexPublicEvent,
  eventPublisher,
  grokPublicEvent,
  updateGrokResult,
} = require("../.github/actions/task-driver/index.js");

test("Codex driver exposes public semantic events without command or reasoning payloads", () => {
  assert.deepEqual(codexPublicEvent({
    type: "item.started",
    item: { type: "command_execution", command: "print-secret" },
  }), {
    type: "activity",
    data: { label: "Running a command", status: "running" },
  });
  assert.deepEqual(codexPublicEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "User-visible answer" },
  }), {
    type: "message",
    data: { text: "User-visible answer" },
  });
  assert.equal(codexPublicEvent({ type: "item.completed", item: { type: "reasoning", text: "private" } }), undefined);
});

test("Grok driver emits text deltas and omits thought content", () => {
  assert.deepEqual(grokPublicEvent({ type: "text", data: "Hello" }), {
    type: "message_delta",
    data: { text: "Hello" },
  });
  assert.equal(grokPublicEvent({ type: "thought", data: "private reasoning" }), undefined);
  assert.deepEqual(grokPublicEvent({ type: "tool_call", title: "Read README" }), {
    type: "activity",
    data: { label: "Read README", status: "running" },
  });
});

test("Grok final result keeps the last user-visible answer after tool activity", () => {
  let state = { text: "", afterTool: false };
  for (const event of [
    { type: "text", data: "I will inspect the file." },
    { type: "tool_call", title: "Read README" },
    { type: "tool_call_update", status: "completed" },
    { type: "text", data: "FINAL_" },
    { type: "text", data: "ANSWER" },
  ]) state = updateGrokResult(state, event);
  assert.equal(state.text, "FINAL_ANSWER");
});

test("driver publisher batches events and preserves their order", async () => {
  const batches = [];
  const publisher = eventPublisher(async (events) => batches.push(events));
  for (let index = 0; index < 12; index += 1) {
    publisher.add({ type: "message_delta", data: { text: String(index) } });
  }
  await publisher.finish();
  assert.deepEqual(batches.flat().map(({ data }) => data.text), Array.from({ length: 12 }, (_, index) => String(index)));
});
