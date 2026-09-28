import { TASK_LIMITS, isTaskId, isTerminalTask, boundedTaskResult } from "../../../shared/task-contract.ts";
import { TaskError, type TaskErrorCode } from "../../../shared/task-errors.ts";
import type { TaskSnapshot, TaskExecution, TaskControl } from "./task-request.ts";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

type TaskRecord = TaskSnapshot & {
  ownerId: string; repository: string; prompt?: string; execution?: TaskExecution;
  expiresAt?: number; startupDeadline?: number; finishDigest?: string;
};
type FinishOutcome = { status: "completed"; result: NonNullable<TaskSnapshot["result"]> } |
  { status: "failed"; error: ReturnType<TaskError["toJSON"]> };
type TerminalOutcome = FinishOutcome | { status: "cancelled"; error: ReturnType<TaskError["toJSON"]> };
type TaskStorage = Pick<DurableObjectStorage, "get" | "put" | "transaction" | "deleteAll" | "setAlarm" | "deleteAlarm">;

const encoder = new TextEncoder();
const KEY = "task";
function fail(code: TaskErrorCode = "INVALID_TASK_INPUT"): never { throw new TaskError(code); }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const validOwner = (id: unknown): id is string => typeof id === "string" && /^[1-9]\d*$/.test(id);
const sameExecution = (a: TaskExecution | undefined, b: TaskExecution) => Boolean(a && b && a.ownerId === b.ownerId &&
  a.repository === b.repository && a.runId === b.runId && a.runAttempt === b.runAttempt);

export function publicTask(task: TaskRecord): TaskSnapshot {
  const { taskId, executor, status, createdAt, updatedAt, finishedAt, runUrl, result, error } = task;
  return { taskId, executor, status, createdAt, updatedAt,
    ...(finishedAt && { finishedAt }), ...(runUrl && { runUrl }),
    ...(result && { result }), ...(error && { error }) };
}

export function validateTaskInput(value: unknown): asserts value is Record<string, unknown> & { executor: "codex" | "grok"; prompt: string } {
  if (!isRecord(value) || (value.executor !== "codex" && value.executor !== "grok") || typeof value.prompt !== "string" ||
      !value.prompt.trim() || encoder.encode(value.prompt).length > TASK_LIMITS.promptBytes) fail();
}

export function taskWaitSeconds(value: unknown = TASK_LIMITS.waitSeconds): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > TASK_LIMITS.waitSeconds) fail();
  return value;
}

function validateExecution(value: unknown): asserts value is TaskExecution {
  if (!isRecord(value) || !validOwner(value.ownerId) || !validOwner(value.runId) ||
      !validOwner(value.runAttempt) || typeof value.repository !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(value.repository)) fail("CLAIM_REJECTED");
}

async function normalizedFinish(input: unknown): Promise<{ outcome: FinishOutcome; digest: string }> {
  if (!isRecord(input)) fail();
  let outcome: FinishOutcome;
  let canonical: string;
  if (input.status === "completed") {
    const result = isRecord(input.result) ? input.result : {};
    outcome = { status: "completed", result: boundedTaskResult(result.finalResponse, result.truncated) };
    // Hash the full input, not its truncated retained result.
    canonical = JSON.stringify({ status: "completed", finalResponse: result.finalResponse, truncated: result.truncated === true });
  } else if (input.status === "failed") {
    let error: ReturnType<TaskError["toJSON"]>;
    try { error = new TaskError(isRecord(input.error) ? input.error.code : undefined).toJSON(); } catch { fail(); }
    if (encoder.encode(JSON.stringify(error)).length > TASK_LIMITS.errorBytes) fail();
    outcome = { status: "failed", error };
    canonical = JSON.stringify({ status: "failed", code: error.code });
  } else fail();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { outcome, digest };
}

/** One SQLite-backed Task; no external I/O occurs inside a storage transaction. */
export class TaskStore {
  readonly storage: TaskStorage;
  now: () => number;
  readonly waiters = new Set<() => void>();

  constructor(storage: TaskStorage, { now = Date.now }: { now?: () => number } = {}) {
    this.storage = storage;
    this.now = now;
  }

  async transaction<T>(operation: (task: TaskRecord | undefined) => T | Promise<T>): Promise<T> {
    type TransactionResult = { expired: true } | { error: TaskError; changed: true } | { value: T; changed: boolean };
    const result = await this.storage.transaction<TransactionResult>(async () => {
      const task = await this.storage.get<TaskRecord>(KEY);
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
    if ("changed" in result && result.changed) this.changed();
    // deleteAll is itself atomic, but Cloudflare forbids it inside a transaction.
    // Expired terminal records cannot change, and create callers only issue fresh IDs.
    if ("expired" in result) {
      await this.storage.deleteAll();
      this.changed();
      fail("TASK_NOT_FOUND");
    }
    if ("error" in result) throw result.error;
    return result.value;
  }

  async save(task: TaskRecord): Promise<void> {
    await this.storage.put(KEY, task);
    if (task.expiresAt) await this.storage.setAlarm(task.expiresAt);
    else if (!task.execution && task.startupDeadline) await this.storage.setAlarm(task.startupDeadline);
    else await this.storage.deleteAlarm();
  }

  changed() {
    for (const wake of this.waiters) wake();
  }

  owned(task: TaskRecord | undefined, ownerId: unknown): TaskRecord {
    if (!task || task.ownerId !== ownerId) fail("TASK_NOT_FOUND");
    return task;
  }

  async create(input: unknown): Promise<TaskSnapshot> {
    if (!isRecord(input)) fail();
    validateTaskInput(input);
    const { taskId, ownerId, executor, prompt, repository } = input;
    if (!isTaskId(taskId) || !validOwner(ownerId) ||
        typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) fail();
    return this.transaction(async (existing) => {
      if (existing) fail();
      const now = new Date(this.now()).toISOString();
      const task: TaskRecord = { taskId, ownerId, executor, prompt, repository,
        status: "queued", createdAt: now, updatedAt: now, startupDeadline: this.now() + TASK_LIMITS.startupMs };
      await this.save(task);
      return publicTask(task);
    });
  }

  async read(ownerId: unknown): Promise<TaskSnapshot> {
    return this.transaction((task) => publicTask(this.owned(task, ownerId)));
  }

  // Internal control-plane metadata, never returned directly through MCP.
  async control(ownerId: unknown): Promise<TaskControl> {
    return this.transaction((task) => {
      task = this.owned(task, ownerId);
      return { task: publicTask(task), execution: task.execution };
    });
  }

  async cancel(ownerId: unknown): Promise<TaskControl> {
    let changed = false;
    const result = await this.transaction(async (task) => {
      task = this.owned(task, ownerId);
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

  async claim(execution: unknown) {
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

  async commitTerminal(task: TaskRecord, outcome: TerminalOutcome, digest?: string): Promise<TaskSnapshot> {
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

  async finish(execution: unknown, input: unknown): Promise<TaskSnapshot> {
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

  async dispatchFailed(ownerId: unknown): Promise<TaskSnapshot> {
    let changed = false;
    const result = await this.transaction(async (task) => {
      task = this.owned(task, ownerId);
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

  async executionEnded(ownerId: unknown, execution: unknown, conclusion: unknown): Promise<TaskSnapshot> {
    validateExecution(execution);
    if (typeof conclusion !== "string" || !["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"].includes(conclusion)) fail();
    let changed = false;
    const result = await this.transaction(async (task) => {
      task = this.owned(task, ownerId);
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

  async wait(ownerId: unknown, timeoutSeconds?: unknown, observedStatus?: unknown): Promise<TaskSnapshot> {
    const seconds = taskWaitSeconds(timeoutSeconds);
    let wake!: () => void;
    const changed = new Promise<void>((resolve) => { wake = resolve; });
    // Subscribe before reading: a finish between read and wait cannot be lost.
    this.waiters.add(wake);
    let timer: ReturnType<typeof setTimeout> | undefined;
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

  async alarm(): Promise<void> {
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
