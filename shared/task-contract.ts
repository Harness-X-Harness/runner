import { TaskError } from "./task-errors.ts";

export const TASK_LIMITS = Object.freeze({
  promptBytes: 64 * 1024,
  resultBytes: 64 * 1024,
  errorBytes: 1024,
  callbackBytes: 1024 * 1024,
  waitSeconds: 25,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  startupMs: 10 * 60 * 1000,
});
const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);
export const isTerminalTask = (status: unknown): boolean => typeof status === "string" && TERMINAL_STATUSES.includes(status);
export const isTaskId = (value: unknown): value is string => typeof value === "string" &&
  /^task_[a-f0-9]{32}$/.test(value);
export const newTaskId = () => `task_${[...crypto.getRandomValues(new Uint8Array(16))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export const TASK_WORKFLOW = "run-task.yml";

export function boundedTaskResult(text: unknown, alreadyTruncated: unknown = false): { finalResponse: string; truncated?: true } {
  if (typeof text !== "string" || !text.trim() || typeof alreadyTruncated !== "boolean") {
    throw new TaskError("INVALID_TASK_INPUT");
  }
  const bytes = new TextEncoder().encode(text);
  const truncated = alreadyTruncated || bytes.length > TASK_LIMITS.resultBytes;
  const finalResponse = bytes.length > TASK_LIMITS.resultBytes
    ? new TextDecoder().decode(bytes.subarray(0, TASK_LIMITS.resultBytes), { stream: true }) : text;
  if (!finalResponse.trim()) {
    throw new TaskError("INVALID_TASK_INPUT");
  }
  return { finalResponse, ...(truncated && { truncated: true }) };
}
