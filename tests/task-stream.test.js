import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTaskStatusEvent,
  appendTaskStreamEvents,
  createTaskStreamToken,
  taskStreamIsTruncated,
  taskStreamTokenMatches,
} from "../apps/chatgpt-app/src/task-stream.js";

test("task stream assigns monotonic sequence numbers and retains a bounded suffix", () => {
  const first = appendTaskStreamEvents(
    { nextSeq: 1, events: [] },
    [
      { type: "activity", data: { label: "Running a command", status: "running" } },
      { type: "message_delta", data: { text: "Hello" } },
    ],
    { now: "2026-08-18T00:00:00.000Z", limit: 2 },
  );
  const second = appendTaskStreamEvents(
    first.state,
    [{ type: "message", data: { text: "Done" } }],
    { now: "2026-08-18T00:00:01.000Z", limit: 2 },
  );

  assert.deepEqual(first.appended.map(({ seq }) => seq), [1, 2]);
  assert.deepEqual(second.state.events.map(({ seq }) => seq), [2, 3]);
  assert.equal(second.state.nextSeq, 4);
  assert.equal(taskStreamIsTruncated(0, second.state.events[0].seq), true);
  assert.equal(taskStreamIsTruncated(1, second.state.events[0].seq), false);
});

test("terminal tasks reject late driver output while their final status stays in the stream", () => {
  const status = appendTaskStatusEvent(
    { nextSeq: 4, events: [] },
    {
      id: "task_123",
      status: "completed",
      prompt: "private",
      streamToken: "private",
      result: { summary: "Complete", secret: "private" },
    },
    { now: "2026-08-18T00:00:00.000Z" },
  );
  const late = appendTaskStreamEvents(
    status.state,
    [{ type: "message", data: { text: "late" } }],
    { terminal: true },
  );

  assert.equal(status.appended[0].seq, 4);
  assert.deepEqual(status.appended[0].data.result, { summary: "Complete" });
  assert.equal(status.appended[0].data.streamToken, undefined);
  assert.deepEqual(late.appended, []);
  assert.equal(late.state.nextSeq, 5);
});

test("task stream capabilities are opaque and compared exactly", () => {
  const token = createTaskStreamToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(taskStreamTokenMatches(token, token), true);
  assert.equal(taskStreamTokenMatches(`${token}0`, token), false);
  assert.equal(taskStreamTokenMatches("", ""), false);
});

test("task stream rejects unbounded or unknown runner events", () => {
  assert.throws(
    () => appendTaskStreamEvents({ nextSeq: 1, events: [] }, Array.from({ length: 13 }, () => ({ type: "message", data: { text: "x" } }))),
    /batch is invalid/,
  );
  assert.throws(
    () => appendTaskStreamEvents({ nextSeq: 1, events: [] }, [{ type: "thought", data: { text: "private" } }]),
    /task stream type/,
  );
  assert.throws(
    () => appendTaskStreamEvents({ nextSeq: 1, events: [] }, [{ type: "message", data: { text: "x".repeat(8193) } }]),
    /message is invalid/,
  );
});
