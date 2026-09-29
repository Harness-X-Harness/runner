import { createHash } from "node:crypto";
import { z } from "zod";
import type { EnvironmentPort } from "./environment.ts";
import { EnvironmentOutput } from "./environment-output.ts";

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"),
    argv: z.tuple([z.string().min(1)]).rest(z.string()), cwd: z.string().default("."),
    timeoutSeconds: z.number().positive(),
  }).strict(),
  z.object({ kind: z.literal("agent"), prompt: z.string().min(1).refine(text => text.trim().length > 0),
    model: z.string().min(1).max(200).regex(/^[A-Za-z0-9._~-]+$/).optional(),
    reasoningEffort: z.string().min(1).max(32).regex(/^[A-Za-z0-9._~-]+$/).optional(),
  }).strict(),
]);
type Value = Awaited<ReturnType<EnvironmentPort["command"]>> | Awaited<ReturnType<EnvironmentPort["agent"]>>;
export type OperationResult = { ok: true; value: Value } | { ok: false; code: string };
const safeErrors = new Set(["ENVIRONMENT_RUNTIME_BUSY", "ENVIRONMENT_RUNTIME_CLOSING",
  "ENVIRONMENT_DEADLINE_EXPIRED", "COMMAND_DEADLINE_EXPIRED", "COMMAND_CWD_OUTSIDE_WORKSPACE",
  "COMMAND_CLEANUP_UNCONFIRMED", "INVALID_COMMAND_INPUT", "OPERATION_RESULT_TOO_LARGE",
  "AGENT_MODEL_REJECTED", "AGENT_MODEL_CONFLICT", "AGENT_MODEL_UNAVAILABLE", "AGENT_MODEL_UNCERTAIN"]);

/** Lives with the process, not its socket. Never restore it in a new runtime. */
export class EnvironmentOperations {
  readonly output = new EnvironmentOutput();
  private readonly receipts = new Map<string, { digest: string; result: Promise<string> }>();
  private active?: { taskId: string; cancellation?: Promise<void> };
  private readonly environment: Pick<EnvironmentPort, "command" | "agent" | "close" | "signal">;
  private readonly cancelActive: () => Promise<void>;
  constructor(environment: Pick<EnvironmentPort, "command" | "agent" | "close" | "signal">, cancelActive: () => Promise<void>) {
    this.environment = environment; this.cancelActive = cancelActive;
  }
  current(): { taskId: string; cancelling: boolean } | undefined {
    return this.active && { taskId: this.active.taskId, cancelling: this.active.cancellation !== undefined };
  }

  cancel(taskId: string): Promise<void> {
    const active = this.active;
    if (!active || active.taskId !== taskId) return Promise.resolve();
    // Execution was scheduled first. Recheck identity after that start cut point.
    return active.cancellation ??= Promise.resolve().then(async () => {
      if (this.active === active) await this.cancelActive();
    });
  }

  execute(taskId: string, value: unknown): Promise<OperationResult> {
    if (!/^[\w-]{1,128}$/.test(taskId)) return Promise.reject(new Error("INVALID_OPERATION_ID"));
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) return Promise.reject(new Error("INVALID_OPERATION_INPUT"));
    const input = parsed.data;
    const canonical = JSON.stringify(input);
    if (Buffer.byteLength(canonical) > 65536) return Promise.reject(new Error("INVALID_OPERATION_INPUT"));
    const digest = createHash("sha256").update(canonical).digest("hex");
    const existing = this.receipts.get(taskId);
    if (existing) {
      if (existing.digest !== digest) return Promise.reject(new Error("OPERATION_ID_CONFLICT"));
      return existing.result.then(text => JSON.parse(text) as OperationResult);
    }
    if (this.environment.signal.aborted) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_CLOSING"));
    if (this.active) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_BUSY"));
    // Bounded replay protection: never evict an executed ID to make room.
    if (this.receipts.size >= 256) return Promise.reject(new Error("OPERATION_RECEIPT_CAPACITY"));
    const active = { taskId };
    this.output.begin(taskId);
    this.active = active;
    const result = Promise.resolve().then(async () => {
      const value = input.kind === "agent" ? await this.environment.agent({
        prompt: input.prompt, model: input.model, reasoningEffort: input.reasoningEffort })
        : await this.environment.command({ argv: input.argv, cwd: input.cwd, timeoutSeconds: input.timeoutSeconds });
      const serialized = JSON.stringify({ ok: true, value } satisfies OperationResult);
      if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error("OPERATION_RESULT_TOO_LARGE");
      return serialized;
    }).catch((error: unknown) => {
      if (input.kind === "command" && error instanceof Error && error.message === "COMMAND_CANCELLED_BEFORE_START") {
        return JSON.stringify({ ok: true, value: { exitCode: null, signal: null, stdout: "", stderr: "",
          truncated: false, stopReason: "cancelled" } } satisfies OperationResult);
      }
      return JSON.stringify({ ok: false,
        code: error instanceof Error && safeErrors.has(error.message) ? error.message : "OPERATION_FAILED",
      } satisfies OperationResult);
    }).finally(() => { if (this.active === active) this.active = undefined; });
    this.receipts.set(taskId, { digest, result });
    // Independent decoded copies prevent a consumer from mutating the receipt.
    return result.then(text => JSON.parse(text) as OperationResult);
  }
}
