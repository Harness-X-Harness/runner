export const EXECUTORS = ["codex", "claude", "grok"];
export const MODES = ["analyze", "edit", "pull_request"];
export const TASK_STATUSES = [
  "queued",
  "running",
  "testing",
  "committing",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
];
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

export function validateSubmitInput(input) {
  const repo = String(input?.repo ?? "");
  const ref = String(input?.ref ?? "main");
  const prompt = String(input?.prompt ?? "");
  const executor = String(input?.executor ?? "");
  const mode = String(input?.mode ?? "analyze");

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new TypeError("repo must be owner/repository");
  }
  if (!ref || ref.length > 256) {
    throw new TypeError("ref must be a non-empty git reference");
  }
  if (!prompt.trim()) {
    throw new TypeError("prompt is required");
  }
  if (!EXECUTORS.includes(executor)) {
    throw new TypeError(`executor must be one of: ${EXECUTORS.join(", ")}`);
  }
  if (!MODES.includes(mode)) {
    throw new TypeError(`mode must be one of: ${MODES.join(", ")}`);
  }

  return { repo, ref, prompt, executor, mode };
}

export function publicTask(task) {
  const safeTask = {};
  for (const field of ["id", "repo", "ref", "executor", "mode", "status", "createdAt", "updatedAt", "runId", "result"]) {
    if (field === "result") {
      if (task.result !== undefined) safeTask.result = publicResult(task.result);
    } else if (task[field] !== undefined) {
      safeTask[field] = task[field];
    }
  }
  return safeTask;
}

function publicResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  return Object.fromEntries(
    ["commit", "branch", "pullRequest", "summary"]
      .filter((field) => typeof result[field] === "string")
      .map((field) => [field, result[field]]),
  );
}

export function applyTaskEvent(task, event) {
  if (!TASK_STATUSES.includes(event?.status)) {
    throw new TypeError(`status must be one of: ${TASK_STATUSES.join(", ")}`);
  }

  if (TERMINAL_STATUSES.includes(task.status)) return task;

  if (task.status === "cancel_requested" && event.status !== "cancelled") {
    return {
      ...task,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    };
  }

  const next = {
    ...task,
    status: event.status,
    updatedAt: new Date().toISOString(),
  };

  if (event.runId !== undefined) next.runId = String(event.runId);
  if (event.result !== undefined) next.result = event.result;
  if (event.error !== undefined) next.error = String(event.error);
  return next;
}
