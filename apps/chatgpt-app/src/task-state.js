import { TASK_LIMITS, isTaskId, isTerminalTask, boundedTaskResult } from "../../../shared/task-contract.js";
import { TaskError } from "../../../shared/task-errors.js";

/** @typedef {{ownerId: string, repository: string, runId: string, runAttempt: string}} TaskExecution */
/** @typedef {{taskId: string, ownerId: string, executor: string, repository: string,
 * status: string, createdAt: string, updatedAt: string, prompt?: string,
 * execution?: TaskExecution, runUrl?: string, finishedAt?: string, expiresAt?: number, startupDeadline?: number,
 * result?: {finalResponse: string, truncated?: boolean},
 * error?: {code: string, message: string, retryable: boolean}, finishDigest?: string}} TaskRecord */

const encoder = new TextEncoder();
const KEY = "task";
const fail = (code = "INVALID_TASK_INPUT") => { throw new TaskError(code); };
const validOwner = (id) => typeof id === "string" && /^[1-9]\d*$/.test(id);
const sameExecution = (a, b) => Boolean(a && b && a.ownerId === b.ownerId &&
  a.repository === b.repository && a.runId === b.runId && a.runAttempt === b.runAttempt);

export function publicTask(task) {
  const { taskId, executor, status, createdAt, updatedAt, finishedAt, runUrl, result, error } = task;
  return { taskId, executor, status, createdAt, updatedAt,
    ...(finishedAt && { finishedAt }), ...(runUrl && { runUrl }),
    ...(result && { result }), ...(error && { error }) };
}

export function validateTaskInput({ executor, prompt }) {
  if (!["codex", "grok"].includes(executor) || typeof prompt !== "string" ||
      !prompt.trim() || encoder.encode(prompt).length > TASK_LIMITS.promptBytes) fail();
}

/** @param {number=} value @returns {number} */
export function taskWaitSeconds(value = TASK_LIMITS.waitSeconds) {
  if (!Number.isFinite(value) || value < 0 || value > TASK_LIMITS.waitSeconds) fail();
  return value;
}

function validateExecution(value) {
  if (!value || !validOwner(value.ownerId) || !validOwner(value.runId) ||
      !validOwner(value.runAttempt) || typeof value.repository !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(value.repository)) fail("CLAIM_REJECTED");
}

async function normalizedFinish(input) {
  let outcome;
  if (input?.status === "completed") {
    outcome = { status: "completed", result: boundedTaskResult(input.result?.finalResponse, input.result?.truncated) };
  } else if (input?.status === "failed") {
    let error;
    try { error = new TaskError(input.error?.code).toJSON(); } catch { fail(); }
    if (encoder.encode(JSON.stringify(error)).length > TASK_LIMITS.errorBytes) fail();
    outcome = { status: "failed", error };
  } else fail();
  // Include the complete semantic input: different truncated tails are not identical replays.
  const canonical = JSON.stringify(input.status === "completed"
    ? { status: "completed", finalResponse: input.result.finalResponse, truncated: input.result.truncated === true }
    : { status: "failed", code: outcome.error.code });
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { outcome, digest };
}

/** One SQLite-backed Task; no external I/O occurs inside a storage transaction. */
export class TaskStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
    this.waiters = new Set();
  }

  async transaction(operation) {
    const result = await this.storage.transaction(async () => {
      let task = /** @type {TaskRecord | undefined} */ (await this.storage.get(KEY));
      if (task?.expiresAt !== undefined && task.expiresAt <= this.now()) {
        return { expired: true };
      }
      let expiredStartup = false;
      if (task && !isTerminalTask(task.status) && !task.execution &&
          task.startupDeadline !== undefined && task.startupDeadline <= this.now()) {
        const cancelled = task.status === "cancelling";
        await this.commitTerminal(task, { status: cancelled ? "cancelled" : "failed",
          error: new TaskError(cancelled ? "CANCELLED" : "DISPATCH_FAILED").toJSON() });
        expiredStartup = true;
      }
      try { return { value: await operation(task), changed: expiredStartup }; }
      catch (error) {
        // Rejected late claims must not roll back the newly committed expiry.
        if (expiredStartup && error instanceof TaskError) return { error, changed: true };
        throw error;
      }
    });
    if (result.changed) this.changed();
    // deleteAll is itself atomic, but Cloudflare forbids it inside a transaction.
    // Expired terminal records cannot change, and create callers only issue fresh IDs.
    if (result.expired) {
      await this.storage.deleteAll();
      this.changed();
      fail("TASK_NOT_FOUND");
    }
    if (result.error) throw result.error;
    return result.value;
  }

  async save(task) {
    await this.storage.put(KEY, task);
    if (task.expiresAt) await this.storage.setAlarm(task.expiresAt);
    else if (!task.execution && task.startupDeadline) await this.storage.setAlarm(task.startupDeadline);
    else await this.storage.deleteAlarm();
  }

  changed() {
    for (const wake of this.waiters) wake();
  }

  owned(task, ownerId) {
    if (!task || task.ownerId !== ownerId) fail("TASK_NOT_FOUND");
    return task;
  }

  async create({ taskId, ownerId, executor, prompt, repository }) {
    validateTaskInput({ executor, prompt });
    if (!isTaskId(taskId) || !validOwner(ownerId) ||
        typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) fail();
    return this.transaction(async (existing) => {
      if (existing) fail();
      const now = new Date(this.now()).toISOString();
      const task = { taskId, ownerId, executor, prompt, repository,
        status: "queued", createdAt: now, updatedAt: now, startupDeadline: this.now() + TASK_LIMITS.startupMs };
      await this.save(task);
      return publicTask(task);
    });
  }

  async read(ownerId) {
    return this.transaction((task) => publicTask(this.owned(task, ownerId)));
  }

  // Internal control-plane metadata, never returned directly through MCP.
  async control(ownerId) {
    return this.transaction((task) => {
      this.owned(task, ownerId);
      return { task: publicTask(task), execution: task.execution };
    });
  }

  async cancel(ownerId) {
    let changed = false;
    const result = await this.transaction(async (task) => {
      this.owned(task, ownerId);
      if (!isTerminalTask(task.status) && task.status !== "cancelling") {
        task.status = "cancelling";
        task.updatedAt = new Date(this.now()).toISOString();
        await this.save(task);
        changed = true;
      }
      return { task: publicTask(task), execution: task.execution };
    });
    if (changed) this.changed();
    return result;
  }

  async claim(execution) {
    validateExecution(execution);
    let changed = false;
    const result = await this.transaction(async (task) => {
      if (!task) fail("TASK_NOT_FOUND");
      if (task.ownerId !== execution.ownerId || task.repository !== execution.repository || !["queued", "running"].includes(task.status) ||
          (task.execution && !sameExecution(task.execution, execution))) fail("CLAIM_REJECTED");
      if (!task.execution) {
        task.execution = { ownerId: execution.ownerId, repository: execution.repository,
          runId: execution.runId, runAttempt: execution.runAttempt };
        task.runUrl = `https://github.com/${task.repository}/actions/runs/${execution.runId}`;
        task.status = "running";
        task.updatedAt = new Date(this.now()).toISOString();
        await this.save(task);
        changed = true;
      }
      return { taskId: task.taskId, executor: task.executor, prompt: task.prompt };
    });
    if (changed) this.changed();
    return result;
  }

  async commitTerminal(task, outcome, digest) {
    Object.assign(task, outcome);
    task.finishedAt = new Date(this.now()).toISOString();
    task.updatedAt = task.finishedAt;
    task.expiresAt = this.now() + TASK_LIMITS.retentionMs;
    if (digest) task.finishDigest = digest;
    delete task.prompt;
    delete task.startupDeadline;
    await this.save(task);
    return publicTask(task);
  }

  async finish(execution, input) {
    validateExecution(execution);
    const { outcome, digest } = await normalizedFinish(input);
    let changed = false;
    const result = await this.transaction(async (task) => {
      if (!task) fail("TASK_NOT_FOUND");
      if (!sameExecution(task.execution, execution)) fail("CLAIM_REJECTED");
      if (isTerminalTask(task.status)) {
        if (task.finishDigest !== digest) fail("CLAIM_REJECTED");
        return publicTask(task);
      }
      const result = await this.commitTerminal(task, outcome, digest);
      changed = true;
      return result;
    });
    if (changed) this.changed();
    return result;
  }

  async dispatchFailed(ownerId) {
    let changed = false;
    const result = await this.transaction(async (task) => {
      this.owned(task, ownerId);
      if (isTerminalTask(task.status) || task.execution) return publicTask(task);
      const cancelled = task.status === "cancelling";
      const result = await this.commitTerminal(task, { status: cancelled ? "cancelled" : "failed",
        error: new TaskError(cancelled ? "CANCELLED" : "DISPATCH_FAILED").toJSON() });
      changed = true;
      return result;
    });
    if (changed) this.changed();
    return result;
  }

  async executionEnded(ownerId, execution, conclusion) {
    validateExecution(execution);
    if (!["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"].includes(conclusion)) fail();
    let changed = false;
    const result = await this.transaction(async (task) => {
      this.owned(task, ownerId);
      if (!sameExecution(task.execution, execution)) fail("CLAIM_REJECTED");
      if (isTerminalTask(task.status)) return publicTask(task);
      const cancelled = conclusion === "cancelled";
      const result = await this.commitTerminal(task, { status: cancelled ? "cancelled" : "failed",
        error: new TaskError(cancelled ? "CANCELLED" :
          conclusion === "timed_out" ? "TASK_TIMEOUT" : "EXECUTION_ENDED").toJSON() });
      changed = true;
      return result;
    });
    if (changed) this.changed();
    return result;
  }

  async wait(ownerId, timeoutSeconds, observedStatus) {
    const seconds = taskWaitSeconds(timeoutSeconds);
    let wake;
    const changed = new Promise((resolve) => { wake = resolve; });
    // Subscribe before reading: a finish between read and wait cannot be lost.
    this.waiters.add(wake);
    let timer;
    try {
      const task = await this.read(ownerId);
      if (isTerminalTask(task.status) || !seconds ||
          (observedStatus !== undefined && task.status !== observedStatus)) return task;
      await Promise.race([changed, new Promise((resolve) => { timer = setTimeout(resolve, seconds * 1000); })]);
      return await this.read(ownerId);
    } finally {
      clearTimeout(timer);
      this.waiters.delete(wake);
    }
  }

  async alarm() {
    try {
      await this.transaction(async (task) => {
        if (task?.expiresAt) await this.storage.setAlarm(task.expiresAt);
        else if (task?.startupDeadline && !task.execution) await this.storage.setAlarm(task.startupDeadline);
      });
    } catch (error) {
      if (!(error instanceof TaskError) || error.code !== "TASK_NOT_FOUND") throw error;
      this.changed();
    }
  }
}
