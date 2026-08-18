import { publicTask } from "./task.js";

export const TASK_STREAM_LIMIT = 256;
export const TASK_STREAM_BATCH_LIMIT = 12;
export const TASK_STREAM_TYPES = ["message", "message_delta", "activity"];

export function createTaskStreamToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function taskStreamTokenMatches(actual, expected) {
  const left = new TextEncoder().encode(String(actual ?? ""));
  const right = new TextEncoder().encode(String(expected ?? ""));
  if (left.length !== right.length || left.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function taskStreamIsTruncated(cursor, oldestSeq) {
  return cursor + 1 < oldestSeq;
}

export function appendTaskStreamEvents(
  state,
  inputEvents,
  { terminal = false, now = new Date().toISOString(), limit = TASK_STREAM_LIMIT } = {},
) {
  if (terminal) return { state, appended: [] };
  if (!Array.isArray(inputEvents) || inputEvents.length > TASK_STREAM_BATCH_LIMIT) {
    throw new TypeError("task stream batch is invalid");
  }
  const appended = [];
  let nextSeq = Number(state?.nextSeq ?? 1);
  for (const input of inputEvents) {
    const event = normalizeRunnerEvent(input);
    appended.push({ seq: nextSeq, ...event, createdAt: now });
    nextSeq += 1;
  }
  return {
    state: {
      nextSeq,
      events: [...(state?.events ?? []), ...appended].slice(-limit),
    },
    appended,
  };
}

export function appendTaskStatusEvent(
  state,
  task,
  { now = new Date().toISOString(), limit = TASK_STREAM_LIMIT } = {},
) {
  const event = {
    seq: Number(state?.nextSeq ?? 1),
    type: "status",
    data: publicTask(task),
    createdAt: now,
  };
  return {
    state: {
      nextSeq: event.seq + 1,
      events: [...(state?.events ?? []), event].slice(-limit),
    },
    appended: [event],
  };
}

function normalizeRunnerEvent(input) {
  if (!TASK_STREAM_TYPES.includes(input?.type)) {
    throw new TypeError(`task stream type must be one of: ${TASK_STREAM_TYPES.join(", ")}`);
  }
  if (input.type === "message" || input.type === "message_delta") {
    const text = String(input?.data?.text ?? "");
    if (!text || text.length > 8_192) throw new TypeError("task stream message is invalid");
    return { type: input.type, data: { text } };
  }
  const label = String(input?.data?.label ?? "");
  const status = String(input?.data?.status ?? "running");
  if (!label || label.length > 240) throw new TypeError("task stream activity is invalid");
  if (!["running", "completed", "failed"].includes(status)) {
    throw new TypeError("task stream activity status is invalid");
  }
  return { type: input.type, data: { label, status } };
}
