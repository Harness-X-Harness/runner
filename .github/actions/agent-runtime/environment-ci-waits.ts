import { randomUUID } from "node:crypto";
import { exactCompletion, githubRunInput, type GithubRunInput, type GithubRunCompletion } from "./github-run-contract.ts";
import type { RegisteredRunWait } from "./github-run-wait.ts";

type Pending = { taskId: string; waitId: string; target: GithubRunInput; observation?: GithubRunCompletion };
type Receipt = { pending: Pending; accepted: ReturnType<typeof Promise.withResolvers<void>>;
  result: ReturnType<typeof Promise.withResolvers<GithubRunCompletion>>; closed: boolean;
  completed?: GithubRunCompletion; detach(): void };

/** Runtime-owned promises survive socket replacement. Only durable acknowledgements
 * release registration or deliver results to the original native tool call. */
export class EnvironmentCiWaits {
  private readonly receipts = new Map<string, Receipt>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) listener(); }
  pending(): Pending[] {
    return [...this.receipts.values()].filter(record => !record.closed && !record.completed)
      .map(record => structuredClone(record.pending));
  }

  async register(taskId: string, value: GithubRunInput, signal: AbortSignal): Promise<RegisteredRunWait> {
    signal.throwIfAborted();
    if (!/^[\w-]{1,128}$/.test(taskId)) throw new Error("INVALID_TASK_ID");
    if (this.receipts.size >= 256) throw new Error("CI_WAIT_CAPACITY");
    const pending = { taskId, waitId: randomUUID(), target: githubRunInput.parse(value) };
    const accepted = Promise.withResolvers<void>();
    const result = Promise.withResolvers<GithubRunCompletion>();
    void accepted.promise.catch(() => {}); void result.promise.catch(() => {});
    const abort = () => this.reject(taskId, pending.waitId, "CI_WAIT_CANCELLED");
    const record: Receipt = { pending, accepted, result, closed: false,
      detach: () => signal.removeEventListener("abort", abort) };
    this.receipts.set(pending.waitId, record);
    signal.addEventListener("abort", abort, { once: true });
    this.notify();
    await accepted.promise;
    signal.throwIfAborted();
    return {
      result: result.promise,
      commit: async value => {
        if (record.closed) throw new Error("CI_WAIT_CANCELLED");
        record.pending.observation = exactCompletion(pending.target, value);
        this.notify();
        await result.promise;
      },
      close: async () => {
        record.closed = true; record.detach();
        result.reject(new Error("CI_WAIT_CLOSED")); this.notify();
      },
    };
  }

  private receipt(taskId: string, waitId: string): Receipt {
    const record = this.receipts.get(waitId);
    if (!record || record.pending.taskId !== taskId) throw new Error("CI_WAIT_NOT_FOUND");
    return record;
  }

  accept(taskId: string, waitId: string): void {
    const record = this.receipt(taskId, waitId);
    if (!record.closed) record.accepted.resolve();
  }
  complete(taskId: string, waitId: string, value: unknown): void {
    const record = this.receipt(taskId, waitId);
    if (record.closed) return;
    const result = exactCompletion(record.pending.target, value);
    if (record.completed) {
      if (JSON.stringify(record.completed) !== JSON.stringify(result)) throw new Error("CI_WAIT_RESULT_CONFLICT");
      return;
    }
    record.completed = result;
    record.accepted.resolve(); record.result.resolve(structuredClone(result));
    this.notify();
  }
  reject(taskId: string, waitId: string, code: string): void {
    const record = this.receipt(taskId, waitId);
    if (record.closed) return;
    record.closed = true; record.detach();
    const error = new Error(code);
    record.accepted.reject(error); record.result.reject(error); this.notify();
  }
  cancel(taskId: string): void {
    for (const record of this.receipts.values()) {
      if (record.pending.taskId === taskId) this.reject(taskId, record.pending.waitId, "CI_WAIT_CANCELLED");
    }
  }
}
