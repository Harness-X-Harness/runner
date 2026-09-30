import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { dispatchEnvironmentWorkflow, observeJobStart, observeWorkflowExecution, requestWorkflowStop } from "./task-github.ts";
import { ENVIRONMENT_WORKFLOW } from "./environment-callback.ts";
import { EnvironmentAdmission, type AdmissionResult, type CapacityRejection } from "./environment-admission.ts";
import { EnvironmentCreation, environmentCreationInput, type EnvironmentCreationRecord } from "./environment-creation.ts";
import { observeTask, observeSnapshots } from "./task-observation.ts";
import { snapshotStream } from "./snapshot-stream.ts";
import { environmentTask } from "./environment-task.ts";
import { lifecycleTask, type LifecycleKind, type LifecycleReceipt } from "./environment-lifecycle-task.ts";
import { inputRequest, inputAnswer, type InputRecord } from "./environment-task-input.ts";
import { emptyOutput, ENVIRONMENT_OUTPUT_BYTES, type OutputSnapshot } from "../../../shared/environment-output.ts";
import { githubRunInput, githubRunCompletion, exactCompletion, type GithubRunInput, type GithubRunCompletion } from "../../../.github/actions/agent-runtime/github-run-contract.ts";
import { agentModelState, type AgentModelState } from "../../../.github/actions/agent-runtime/agent-model.ts";

type Bindings = {
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentObject>;
  ENVIRONMENT_ADMISSION: DurableObjectNamespace<EnvironmentAdmissionObject>;
  ENVIRONMENT_STARTUP_MS: number;
  GITHUB_RUNNER_REPOSITORY: string;
  GITHUB_RUNNER_REF?: string;
  GITHUB_CI_EVENT_REPOSITORIES?: string;
};
const executionSchema = z.object({
  ownerId: z.string().regex(/^[1-9]\d{0,19}$/),
  repository: z.string(), runId: z.string().regex(/^[1-9]\d*$/),
  runAttempt: z.string().regex(/^[1-9]\d*$/),
}).strict();
const runtimeClaimSchema = executionSchema.extend({ runtimeId: z.string().uuid() });
type RuntimeBinding = { runtimeId: string; generation: number };
type GithubWait = { taskId: string; target: GithubRunInput; result?: GithubRunCompletion };
export type OperationRecord = { request: string; runtimeId: string; createdAt: number; updatedAt: number; expiresAt?: number; cancelRequested?: true; inputs?: Record<string, InputRecord>; result?: unknown };
const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;
export type EnvironmentSnapshot = {
  environmentId: string;
  executor: "codex" | "grok";
  status: "opening" | "ready" | "unavailable" | "closing" | "closed";
  reason?: "startup_expired" | "runtime_expired" | "idle_expired" | "runtime_disconnected";
  createdAt: number;
  expiresAt: number | null;
  idleExpiresAt?: number | null;
  agent?: { state: AgentModelState; observedAt: number; current: boolean };
  activeTaskId: string | null;
};
const operationId = z.string().regex(/^[\w-]{1,128}$/);
const outputSnapshot = z.object({ revision: z.number().int().nonnegative(), text: z.string(), truncated: z.boolean() }).strict()
  .refine(value => new TextEncoder().encode(value.text).length <= ENVIRONMENT_OUTPUT_BYTES &&
    (value.revision !== 0 || (value.text === "" && !value.truncated)));
const runtimeMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent-state"), generation: z.number().int().positive(), state: agentModelState }).strict(),
  z.object({ type: z.literal("ci-register"), generation: z.number().int().positive(), taskId: operationId,
    waitId: z.string().uuid(), target: githubRunInput }).strict(),
  z.object({ type: z.literal("ci-observed"), generation: z.number().int().positive(), taskId: operationId,
    waitId: z.string().uuid(), result: githubRunCompletion }).strict(),
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("output"), generation: z.number().int().positive(), taskId: operationId,
    output: outputSnapshot }).strict(),
  z.object({ type: z.literal("input"), generation: z.number().int().positive(), taskId: operationId,
    inputId: z.string().uuid(), request: inputRequest }).strict(),
  z.object({ type: z.literal("result"), generation: z.number().int().positive(), taskId: operationId,
    output: outputSnapshot,
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: z.record(z.string(), z.unknown()) }).strict(),
      z.object({ ok: z.literal(false), code: z.string().regex(/^[A-Z_]{1,64}$/) }).strict(),
    ]),
  }).strict(),
]);

// RPC methods are internal; HTTP runtime access is gated by the Worker OIDC handler.
export class EnvironmentObject extends DurableObject<Bindings> {
  private readonly creation: EnvironmentCreation;
  private readonly operationObservers = new Map<string, Set<() => void>>();
  private readonly outputObservers = new Map<string, Set<() => void>>();
  private readonly environmentObservers = new Set<() => void>();
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.creation = new EnvironmentCreation(ctx.storage, env.ENVIRONMENT_STARTUP_MS);
  }

  /** Owner-private projection. Reading does not dispatch, release, or infer stop. */
  async readEnvironment(ownerId: string): Promise<EnvironmentSnapshot | null> {
    return this.ctx.storage.transaction(async () => {
      const creation = await this.findRetainedCreation(ownerId);
      if (!creation) return null;
      const deadline = await this.ctx.storage.get<number>("environment-runtime-deadline");
      const current = await this.ctx.storage.get<RuntimeBinding>("environment-runtime");
      const ready = await this.ctx.storage.get<number>("environment-ready-generation");
      const idle = await this.ctx.storage.get<number>("environment-idle-deadline");
      const snapshot: EnvironmentSnapshot = {
        environmentId: creation.environmentId, executor: creation.executor,
        status: "opening", createdAt: creation.createdAt, expiresAt: deadline ?? null, idleExpiresAt: idle ?? null,
        activeTaskId: await this.ctx.storage.get<string>("environment-active-operation") ?? null,
      };
      if (await this.ctx.storage.get("environment-capacity-released") === true) snapshot.status = "closed";
      else if (await this.ctx.storage.get("environment-close-requested") === true) snapshot.status = "closing";
      else if (deadline !== undefined && deadline <= Date.now()) {
        snapshot.status = "unavailable"; snapshot.reason = "runtime_expired";
      } else if (ready === undefined && creation.admitUntil <= Date.now()) {
        snapshot.status = "unavailable"; snapshot.reason = "startup_expired";
      } else if (idle !== undefined && idle <= Date.now()) {
        snapshot.status = "unavailable"; snapshot.reason = "idle_expired";
      } else if (current && deadline !== undefined && ready === current.generation && this.runtimeSocket(current)) {
        snapshot.status = "ready";
      } else if (ready !== undefined) {
        snapshot.status = "unavailable"; snapshot.reason = "runtime_disconnected";
      }
      const agent = await this.ctx.storage.get<{ state: AgentModelState; observedAt: number; generation: number }>("environment-agent-state");
      if (agent) snapshot.agent = { state: agent.state, observedAt: agent.observedAt,
        current: snapshot.status === "ready" && agent.generation === current?.generation };
      return snapshot;
    });
  }

  private runtimeSocket(current: RuntimeBinding): WebSocket | undefined {
    return this.ctx.getWebSockets().find(socket => {
      const binding = socket.deserializeAttachment() as RuntimeBinding | null;
      return socket.readyState === WebSocket.OPEN && binding?.runtimeId === current.runtimeId &&
        binding.generation === current.generation;
    });
  }

  private environmentChanged(): void {
    for (const changed of this.environmentObservers) changed();
  }

  async readLifecycleTask(ownerId: string, kind: LifecycleKind) {
    if (kind !== "open" && kind !== "close") throw new Error("INVALID_LIFECYCLE_KIND");
    return this.ctx.storage.transaction(async () => {
      const creation = await this.creation.find(ownerId);
      if (!creation) return null;
      const expiresAt = await this.ctx.storage.get<number>("environment-results-expires-at");
      if (expiresAt !== undefined && expiresAt <= Date.now()) return null;
      const receipt = await this.ctx.storage.get<LifecycleReceipt>(`environment-lifecycle:${kind}`);
      return receipt ? lifecycleTask(creation.environmentId, kind, receipt, expiresAt) : null;
    });
  }

  async observeLifecycleTask(ownerId: string, kind: LifecycleKind): Promise<ReadableStream<Uint8Array>> {
    if (!await this.readLifecycleTask(ownerId, kind)) throw new Error("TASK_NOT_FOUND");
    return snapshotStream(signal => observeTask({
      subscribe: changed => {
        this.environmentObservers.add(changed);
        return () => { this.environmentObservers.delete(changed); };
      },
      read: async () => {
        const task = await this.readLifecycleTask(ownerId, kind);
        if (!task) throw new Error("TASK_NOT_FOUND");
        return task;
      },
    }, signal));
  }

  /** Cancellation of close never undoes cleanup; a completed open is immutable. */
  async cancelLifecycleTask(ownerId: string, kind: LifecycleKind): Promise<boolean> {
    const cancel = await this.ctx.storage.transaction(async () => {
      await this.creation.read(ownerId);
      await this.retainedUntil();
      if (kind !== "open" && kind !== "close") throw new Error("INVALID_LIFECYCLE_KIND");
      const receipt = await this.ctx.storage.get<LifecycleReceipt>(`environment-lifecycle:${kind}`);
      if (!receipt) throw new Error("TASK_NOT_FOUND");
      if (kind === "close" || receipt.status !== "working") return false;
      if (!receipt.cancelRequested) await this.ctx.storage.put("environment-lifecycle:open",
        { ...receipt, cancelRequested: true, updatedAt: Date.now() });
      await this.ctx.storage.put("environment-close-requested", true);
      return true;
    });
    if (cancel) await this.requestClose(ownerId);
    return cancel;
  }

  private async nextDeadline(): Promise<number> {
    const creation = await this.creation.readInternal();
    const runtime = await this.ctx.storage.get<number>("environment-runtime-deadline");
    if (await this.ctx.storage.get("environment-ready-generation") === undefined) {
      return Math.min(creation.admitUntil, runtime ?? creation.admitUntil);
    }
    if (runtime === undefined) throw new Error("ENVIRONMENT_DEADLINE_MISSING");
    const idle = await this.ctx.storage.get<number>("environment-idle-deadline");
    return Math.min(runtime, idle ?? runtime);
  }

  async alarm(): Promise<void> {
    if (await this.ctx.storage.get("environment-capacity-released") === true) {
      await this.ctx.storage.transaction(async () => {
        const expiresAt = await this.ctx.storage.get<number>("environment-results-expires-at");
        if (expiresAt === undefined) throw new Error("ENVIRONMENT_RETENTION_MISSING");
        if (expiresAt > Date.now()) { await this.ctx.storage.setAlarm(expiresAt); return; }
        for (const prefix of ["environment-operation:", "environment-output:", "environment-lifecycle:", "environment-ci-wait:"]) {
          for (;;) {
            const records = await this.ctx.storage.list({ prefix, limit: 128 });
            if (!records.size) break;
            await this.ctx.storage.delete([...records.keys()]);
          }
        }
        await this.ctx.storage.delete("environment-agent-state");
        await this.ctx.storage.deleteAlarm();
      });
      for (const observers of [...this.operationObservers.values(), ...this.outputObservers.values()]) {
        for (const notify of observers) notify();
      }
      this.environmentChanged();
      return;
    }
    const closing = await this.ctx.storage.transaction(async () => {
      if (await this.ctx.storage.get("environment-capacity-released") === true) return false;
      if (await this.ctx.storage.get("environment-close-requested") === true) return true;
      const deadline = await this.nextDeadline();
      if (deadline > Date.now()) { await this.ctx.storage.setAlarm(deadline); return false; }
      await this.ctx.storage.put("environment-close-requested", true);
      return true;
    });
    if (closing) {
      this.environmentChanged();
      await this.requestClose((await this.creation.readInternal()).ownerId);
    }
    // Elapsed time does not release a reservation once dispatch was issued.
  }

  async observeEnvironment(ownerId: string): Promise<ReadableStream<Uint8Array>> {
    await this.creation.read(ownerId);
    return snapshotStream(signal => observeSnapshots({
      subscribe: changed => {
        this.environmentObservers.add(changed);
        return () => { this.environmentObservers.delete(changed); };
      },
      read: async () => {
        const snapshot = await this.readEnvironment(ownerId);
        if (!snapshot) throw new Error("ENVIRONMENT_NOT_FOUND");
        return snapshot;
      },
    }, signal));
  }

  webSocketClose(socket: WebSocket): void {
    socket.close(1000);
    this.environmentChanged();
  }

  webSocketError(socket: WebSocket): void { socket.close(1011); this.environmentChanged(); }

  // Internal fetch only: the Worker reconstructs this header after OIDC validation.
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 400 });
    }
    let binding: RuntimeBinding & { deadline: number };
    try { binding = await this.bindRuntime(JSON.parse(request.headers.get("x-harness-runtime-claim") ?? "null")); }
    catch { return new Response(null, { status: 409 }); }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ runtimeId: binding.runtimeId, generation: binding.generation });
    pair[1].send(JSON.stringify({ type: "connected", generation: binding.generation, deadline: binding.deadline }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as RuntimeBinding | null;
    const acknowledgement = await this.ctx.storage.transaction(async () => {
      const current = await this.ctx.storage.get<RuntimeBinding>("environment-runtime");
      const deadline = await this.ctx.storage.get<number>("environment-runtime-deadline");
      if (!attachment || !current || current.runtimeId !== attachment.runtimeId ||
          current.generation !== attachment.generation || deadline === undefined || deadline <= Date.now() ||
          await this.ctx.storage.get("environment-close-requested") === true) return false;
      if (typeof message !== "string" || new TextEncoder().encode(message).length > 1024 * 1024) return false;
      let payload: unknown;
      try { payload = JSON.parse(message); } catch { return false; }
      const parsed = runtimeMessage.safeParse(payload);
      if (!parsed.success) return false;
      const incoming = parsed.data;
      if (incoming.type === "ready") {
        if (await this.ctx.storage.get("environment-ready-generation") === undefined &&
            (await this.creation.readInternal()).admitUntil <= Date.now()) return false;
        const idle = await this.ctx.storage.get<number>("environment-idle-deadline");
        if (idle !== undefined && idle <= Date.now()) return false;
        if (idle === undefined && await this.ctx.storage.get("environment-active-operation") === undefined) {
          await this.ctx.storage.put("environment-idle-deadline", Date.now() + IDLE_MS);
        }
        await this.ctx.storage.put("environment-ready-generation", current.generation);
        const open = await this.ctx.storage.get<LifecycleReceipt>("environment-lifecycle:open");
        if (open?.status === "working") await this.ctx.storage.put("environment-lifecycle:open",
          { ...open, status: "completed", updatedAt: Date.now() });
        await this.ctx.storage.setAlarm(await this.nextDeadline());
        return { type: "ready-accepted" };
      }
      if (incoming.type === "agent-state") {
        if (incoming.generation !== current.generation ||
            await this.ctx.storage.get("environment-ready-generation") !== current.generation) return false;
        await this.ctx.storage.put("environment-agent-state", { state: incoming.state, observedAt: Date.now(), generation: current.generation });
        return { type: "agent-state-accepted", generation: current.generation };
      }
      if (incoming.type === "ci-register" || incoming.type === "ci-observed") {
        if (incoming.generation !== current.generation) return false;
        if (incoming.type === "ci-register") {
          try {
            const wait = await this.registerGithubWaitRecord(incoming.taskId, incoming.waitId, incoming.target);
            return wait.result ? { type: "ci-result", generation: current.generation, taskId: incoming.taskId,
              waitId: incoming.waitId, result: wait.result }
              : { type: "ci-accepted", generation: current.generation, taskId: incoming.taskId, waitId: incoming.waitId };
          } catch (error) {
            if (error instanceof Error && ["CI_EVENT_COVERAGE_REQUIRED", "CI_WAIT_TASK_NOT_ACTIVE", "CI_WAIT_CAPACITY", "CI_WAIT_ID_CONFLICT"].includes(error.message)) {
              return { type: "ci-rejected", generation: current.generation, taskId: incoming.taskId, waitId: incoming.waitId, code: error.message };
            }
            throw error;
          }
        }
        if (!await this.activeGithubOperation(incoming.taskId)) return false;
        const key = `environment-ci-wait:${incoming.waitId}`;
        const wait = await this.ctx.storage.get<GithubWait>(key);
        if (!wait || wait.taskId !== incoming.taskId) return false;
        let result: GithubRunCompletion;
        try { result = exactCompletion(wait.target, incoming.result); } catch { return false; }
        if (!wait.result) await this.ctx.storage.put(key, { ...wait, result });
        return { type: "ci-result", generation: current.generation, taskId: incoming.taskId,
          waitId: incoming.waitId, result: wait.result ?? result };
      }
      if (incoming.type === "input") {
        if (incoming.generation !== current.generation || new TextEncoder().encode(JSON.stringify(incoming)).length > 65536) return false;
        const key = `environment-operation:${incoming.taskId}`;
        const record = await this.ctx.storage.get<OperationRecord>(key);
        if (!record || record.runtimeId !== current.runtimeId || record.result !== undefined) return false;
        const old = record.inputs?.[incoming.inputId];
        if (old && JSON.stringify(old.request) !== JSON.stringify(incoming.request)) return false;
        if (!old) {
          if (Object.keys(record.inputs ?? {}).length >= 256) return false;
          await this.ctx.storage.put(key, { ...record, updatedAt: Date.now(),
            inputs: { ...record.inputs, [incoming.inputId]: { request: incoming.request } } });
        }
        return { type: "input-accepted", taskId: incoming.taskId, inputId: incoming.inputId, generation: current.generation };
      }
      if (incoming.type === "output") {
        if (incoming.generation !== current.generation) return false;
        const record = await this.ctx.storage.get<OperationRecord>(`environment-operation:${incoming.taskId}`);
        if (!record || record.runtimeId !== current.runtimeId ||
            !await this.storeOutput(incoming.taskId, incoming.output, record.result !== undefined)) return false;
        return { type: "output-accepted", taskId: incoming.taskId, revision: incoming.output.revision, generation: current.generation };
      }
      if (incoming.generation !== current.generation ||
          new TextEncoder().encode(JSON.stringify(incoming.result)).length > 512 * 1024) return false;
      const key = `environment-operation:${incoming.taskId}`;
      const record = await this.ctx.storage.get<OperationRecord>(key);
      if (!record || record.runtimeId !== current.runtimeId) return false;
      if (record.result !== undefined && JSON.stringify(record.result) !== JSON.stringify(incoming.result)) return false;
      if (!await this.storeOutput(incoming.taskId, incoming.output, record.result !== undefined)) return false;
      if (record.result === undefined) {
        await this.ctx.storage.put(key, { ...record, updatedAt: Date.now(), result: incoming.result });
        await this.ctx.storage.delete("environment-active-operation");
        await this.ctx.storage.put("environment-idle-deadline", Date.now() + IDLE_MS);
        await this.ctx.storage.setAlarm(await this.nextDeadline());
      }
      return { type: "result-accepted", generation: current.generation, taskId: incoming.taskId };
    });
    if (!acknowledgement) { socket.close(1008, "Runtime message rejected"); return; }
    if (acknowledgement.taskId !== undefined && acknowledgement.type !== "output-accepted") {
      for (const changed of this.operationObservers.get(acknowledgement.taskId) ?? []) changed();
    }
    if (acknowledgement.taskId !== undefined && ["output-accepted", "result-accepted"].includes(acknowledgement.type)) {
      for (const changed of this.outputObservers.get(acknowledgement.taskId) ?? []) changed();
    }
    if (["ready-accepted", "result-accepted", "agent-state-accepted"].includes(acknowledgement.type)) this.environmentChanged();
    socket.send(JSON.stringify(acknowledgement));
    if (acknowledgement.type === "ready-accepted") await this.deliverRuntimeMessage();
  }

  // Called only inside the runtime-message transaction. Final output and result
  // commit together; reconnect can replay older snapshots but cannot revise a final.
  private async storeOutput(taskId: string, output: OutputSnapshot, completed: boolean): Promise<boolean> {
    const key = `environment-output:${taskId}`;
    const previous = await this.ctx.storage.get<OutputSnapshot>(key) ?? emptyOutput();
    if (output.revision < previous.revision) return true;
    if (output.revision === previous.revision) return output.text === previous.text && output.truncated === previous.truncated;
    if (completed || previous.truncated || !output.text.startsWith(previous.text)) return false;
    await this.ctx.storage.put(key, output);
    return true;
  }

  async readOutput(ownerId: string, taskId: string): Promise<OutputSnapshot | null> {
    return this.ctx.storage.transaction(async () => {
      if (!await this.readOperation(ownerId, taskId)) return null;
      return await this.ctx.storage.get<OutputSnapshot>(`environment-output:${taskId}`) ?? emptyOutput();
    });
  }

  /** Internal output stream; never mixed into standard Task status notifications. */
  async observeOutput(ownerId: string, taskId: string): Promise<ReadableStream<Uint8Array>> {
    await this.requireOperation(ownerId, taskId);
    return snapshotStream(signal => observeSnapshots({
      subscribe: changed => {
        const observers = this.outputObservers.get(taskId) ?? new Set<() => void>();
        observers.add(changed);
        this.outputObservers.set(taskId, observers);
        return () => {
          observers.delete(changed);
          if (!observers.size) this.outputObservers.delete(taskId);
        };
      },
      read: async signal => {
        signal.throwIfAborted();
        const snapshot = await this.readOutput(ownerId, taskId);
        if (!snapshot) throw new Error("OPERATION_NOT_FOUND");
        return snapshot;
      },
    }, signal));
  }

  private async deliverRuntimeMessage(): Promise<void> {
    // Keep close/rebind from interleaving between eligibility reads and send.
    // This is delivery, not execution confirmation. The durable record remains pending.
    await this.ctx.blockConcurrencyWhile(async () => {
      const closing = await this.ctx.storage.get("environment-close-requested") === true;
      const current = await this.ctx.storage.get<RuntimeBinding>("environment-runtime");
      const deadline = await this.ctx.storage.get<number>("environment-runtime-deadline");
      if (!current ||
          await this.ctx.storage.get("environment-ready-generation") !== current.generation) return;
      const socket = this.runtimeSocket(current);
      if (!socket) return;
      try {
        if (closing) {
          socket.send(JSON.stringify({ type: "close", generation: current.generation }));
          return;
        }
        const taskId = await this.ctx.storage.get<string>("environment-active-operation");
        if (!taskId) return;
        const record = await this.ctx.storage.get<OperationRecord>(`environment-operation:${taskId}`);
        if (!record || record.result !== undefined || record.runtimeId !== current.runtimeId ||
            deadline === undefined || deadline <= Date.now()) return;
        socket.send(JSON.stringify({ type: "execute", generation: current.generation,
          taskId, input: JSON.parse(record.request) }));
        if (record.cancelRequested) socket.send(JSON.stringify({ type: "cancel", generation: current.generation, taskId }));
        else for (const [inputId, input] of Object.entries(record.inputs ?? {})) {
          if (input.response !== undefined) socket.send(JSON.stringify({ type: "input-response",
            generation: current.generation, taskId, inputId, response: input.response }));
        }
        if (!record.cancelRequested) {
          for (const [key, wait] of await this.ctx.storage.list<GithubWait>({ prefix: "environment-ci-wait:", limit: 256 })) {
            if (wait.taskId === taskId && wait.result) socket.send(JSON.stringify({ type: "ci-result", generation: current.generation,
              taskId, waitId: key.slice("environment-ci-wait:".length), result: wait.result }));
          }
        }
      } catch {
        // A reconnecting instance of the same runtime can read this same pending record.
        socket.close(1011, "Operation delivery interrupted");
      }
    });
  }

  private async activeGithubOperation(taskId: string): Promise<boolean> {
    const deadline = await this.ctx.storage.get<number>("environment-runtime-deadline");
    const record = await this.ctx.storage.get<OperationRecord>(`environment-operation:${taskId}`);
    if (await this.ctx.storage.get("environment-close-requested") === true ||
        deadline === undefined || deadline <= Date.now() ||
        await this.ctx.storage.get("environment-active-operation") !== taskId ||
        !record || record.result !== undefined || record.cancelRequested || JSON.parse(record.request).kind !== "agent") {
      return false;
    }
    return true;
  }

  /** Internal runtime registration. The authenticated transport supplies owner and Task. */
  async registerGithubWait(ownerId: string, taskId: string, waitId: string, value: unknown): Promise<GithubWait> {
    return this.ctx.storage.transaction(async () => {
      await this.creation.read(ownerId);
      return this.registerGithubWaitRecord(taskId, waitId, value);
    });
  }

  private async registerGithubWaitRecord(taskId: string, waitId: string, value: unknown): Promise<GithubWait> {
    const target = githubRunInput.parse(value);
    z.string().uuid().parse(waitId);
    const coverage = z.array(z.string()).parse(JSON.parse(this.env.GITHUB_CI_EVENT_REPOSITORIES ?? "[]"));
    if (!coverage.includes(target.repository)) throw new Error("CI_EVENT_COVERAGE_REQUIRED");
    if (!await this.activeGithubOperation(taskId)) throw new Error("CI_WAIT_TASK_NOT_ACTIVE");
    const key = `environment-ci-wait:${waitId}`;
    const existing = await this.ctx.storage.get<GithubWait>(key);
    if (existing) {
      if (existing.taskId !== taskId || JSON.stringify(existing.target) !== JSON.stringify(target)) throw new Error("CI_WAIT_ID_CONFLICT");
      return existing;
    }
    if ((await this.ctx.storage.list({ prefix: "environment-ci-wait:", limit: 256 })).size >= 256) throw new Error("CI_WAIT_CAPACITY");
    const record = { taskId, target };
    await this.ctx.storage.put(key, record);
    return record;
  }

  async readGithubWait(ownerId: string, taskId: string, waitId: string): Promise<GithubWait | null> {
    z.string().uuid().parse(waitId);
    return this.ctx.storage.transaction(async () => {
      await this.creation.read(ownerId);
      if (!await this.activeGithubOperation(taskId)) throw new Error("CI_WAIT_TASK_NOT_ACTIVE");
      const record = await this.ctx.storage.get<GithubWait>(`environment-ci-wait:${waitId}`);
      return record?.taskId === taskId ? record : null;
    });
  }

  /** A trusted event/observation can complete existing waits, never register work. */
  async completeGithubWaits(value: unknown): Promise<number> {
    const result = githubRunCompletion.parse(value);
    const completed = await this.ctx.storage.transaction(async () => {
      const taskId = await this.ctx.storage.get<string>("environment-active-operation");
      if (!taskId) return 0;
      if (!await this.activeGithubOperation(taskId)) return 0;
      let count = 0;
      for (const [key, record] of await this.ctx.storage.list<GithubWait>({ prefix: "environment-ci-wait:", limit: 256 })) {
        const target = record.target;
        if (record.taskId !== taskId || record.result || target.repository !== result.repository ||
            target.runId !== result.runId || target.runAttempt !== result.runAttempt || target.revision !== result.revision) continue;
        await this.ctx.storage.put(key, { ...record, result });
        count++;
      }
      return count;
    });
    if (completed) await this.deliverRuntimeMessage();
    return completed;
  }

  // Internal admission after the public tool validates and canonicalizes its input.
  async reserveOperation(ownerId: string, taskId: string, request: string): Promise<OperationRecord> {
    operationId.parse(taskId);
    z.string().min(1).parse(request);
    if (new TextEncoder().encode(request).length > 65536) throw new Error("INVALID_OPERATION_INPUT");
    const input: unknown = JSON.parse(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("INVALID_OPERATION_INPUT");
    const reserved = await this.ctx.storage.transaction<OperationRecord>(async () => {
      await this.creation.read(ownerId);
      await this.retainedUntil();
      const key = `environment-operation:${taskId}`;
      const existing = await this.ctx.storage.get<OperationRecord>(key);
      if (existing) {
        if (existing.request !== request) throw new Error("OPERATION_ID_CONFLICT");
        return existing;
      }
      if (await this.ctx.storage.get("environment-close-requested") === true) throw new Error("ENVIRONMENT_CLOSING");
      const idle = await this.ctx.storage.get<number>("environment-idle-deadline");
      if (idle !== undefined && idle <= Date.now()) throw new Error("ENVIRONMENT_IDLE_EXPIRED");
      const current = await this.ctx.storage.get<RuntimeBinding>("environment-runtime");
      const deadline = await this.ctx.storage.get<number>("environment-runtime-deadline");
      if (!current || deadline === undefined || deadline <= Date.now() ||
          await this.ctx.storage.get("environment-ready-generation") !== current.generation) throw new Error("ENVIRONMENT_NOT_READY");
      if (!this.runtimeSocket(current)) throw new Error("ENVIRONMENT_NOT_READY");
      if (await this.ctx.storage.get("environment-active-operation") !== undefined) throw new Error("ENVIRONMENT_RUNTIME_BUSY");
      const count = await this.ctx.storage.get<number>("environment-operation-count") ?? 0;
      if (count >= 256) throw new Error("OPERATION_RECEIPT_CAPACITY");
      const now = Date.now();
      const record = { request, runtimeId: current.runtimeId, createdAt: now, updatedAt: now };
      await this.ctx.storage.put({ [key]: record, "environment-active-operation": taskId, "environment-operation-count": count + 1 });
      await this.ctx.storage.delete("environment-idle-deadline");
      await this.ctx.storage.setAlarm(await this.nextDeadline());
      return record;
    });
    this.environmentChanged();
    if (reserved.result === undefined) await this.deliverRuntimeMessage();
    return reserved;
  }

  async readOperation(ownerId: string, taskId: string): Promise<OperationRecord | null> {
    operationId.parse(taskId);
    return this.ctx.storage.transaction(async () => {
      if (!await this.creation.find(ownerId)) return null;
      const expiresAt = await this.ctx.storage.get<number>("environment-results-expires-at");
      if (expiresAt !== undefined && expiresAt <= Date.now()) return null;
      const record = await this.ctx.storage.get<OperationRecord>(`environment-operation:${taskId}`);
      if (!record) return null;
      return expiresAt === undefined ? record : { ...record, expiresAt };
    });
  }

  private async requireOperation(ownerId: string, taskId: string): Promise<OperationRecord> {
    const record = await this.readOperation(ownerId, taskId);
    if (!record) throw new Error("OPERATION_NOT_FOUND");
    return record;
  }

  private async retainedUntil(): Promise<number | undefined> {
    const expiresAt = await this.ctx.storage.get<number>("environment-results-expires-at");
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new Error("ENVIRONMENT_RESULTS_EXPIRED");
    return expiresAt;
  }

  /** Expected private absence crosses RPC as data; storage faults still throw. */
  private async findRetainedCreation(ownerId: string): Promise<EnvironmentCreationRecord | null> {
    const record = await this.creation.find(ownerId);
    if (!record) return null;
    const expiresAt = await this.ctx.storage.get<number>("environment-results-expires-at");
    return expiresAt !== undefined && expiresAt <= Date.now() ? null : record;
  }

  async cancelOperation(ownerId: string, taskId: string): Promise<void> {
    operationId.parse(taskId);
    const state = await this.ctx.storage.transaction(async () => {
      const record = await this.requireOperation(ownerId, taskId);
      if (record.result !== undefined) return { pending: false, changed: false };
      if (!record.cancelRequested) await this.ctx.storage.put(`environment-operation:${taskId}`,
        { ...record, cancelRequested: true, updatedAt: Date.now() });
      return { pending: true, changed: !record.cancelRequested };
    });
    if (state.changed) for (const notify of this.operationObservers.get(taskId) ?? []) notify();
    if (state.pending) await this.deliverRuntimeMessage();
  }

  async answerOperation(ownerId: string, taskId: string, value: unknown): Promise<void> {
    const answers = z.record(z.string(), z.unknown()).parse(value);
    if (!Object.keys(answers).length || new TextEncoder().encode(JSON.stringify(answers)).length > 65536) throw new Error("INVALID_INPUT_RESPONSE");
    const changed = await this.ctx.storage.transaction(async () => {
      const record = await this.requireOperation(ownerId, taskId);
      if (record.result !== undefined || record.cancelRequested) return false;
      const inputs = { ...record.inputs };
      let changed = false;
      for (const [inputId, value] of Object.entries(answers)) {
        const old = Object.hasOwn(inputs, inputId) ? inputs[inputId] : undefined;
        // MCP Tasks ignores keys that are no longer outstanding; first answer wins.
        if (!old || old.response !== undefined) continue;
        const response = inputAnswer(old.request, value);
        changed = true;
        inputs[inputId] = { ...old, response };
      }
      if (changed) await this.ctx.storage.put(`environment-operation:${taskId}`, { ...record, inputs, updatedAt: Date.now() });
      return changed;
    });
    if (changed) {
      for (const notify of this.operationObservers.get(taskId) ?? []) notify();
      await this.deliverRuntimeMessage();
    }
  }

  /** Internal SSE snapshot stream. The public transport owns OAuth and MCP framing. */
  async observeOperation(ownerId: string, taskId: string): Promise<ReadableStream<Uint8Array>> {
    await this.requireOperation(ownerId, taskId);
    return snapshotStream(signal => observeTask({
      subscribe: changed => {
        const observers = this.operationObservers.get(taskId) ?? new Set<() => void>();
        observers.add(changed);
        this.operationObservers.set(taskId, observers);
        return () => {
          observers.delete(changed);
          if (!observers.size) this.operationObservers.delete(taskId);
        };
      },
      read: async signal => {
        signal.throwIfAborted();
        const record = await this.requireOperation(ownerId, taskId);
        signal.throwIfAborted();
        return environmentTask(taskId, record);
      },
    }, signal));
  }

  async initialize(value: unknown): Promise<(EnvironmentCreationRecord & { admitted: true }) | CapacityRejection> {
    const input = environmentCreationInput.parse(value);
    const expectedId = this.env.ENVIRONMENTS.idFromName(input.environmentId);
    if (!this.ctx.id.equals(expectedId)) throw new Error("ENVIRONMENT_ID_MISMATCH");
    const record = await this.creation.create(input);
    if (await this.ctx.storage.get("environment-close-requested") === true) throw new Error("ENVIRONMENT_CLOSING");
    // External I/O follows the committed immutable creation, outside its transaction.
    const admission = await this.env.ENVIRONMENT_ADMISSION.getByName("global").reserve(record);
    if (!admission.admitted) return admission;
    await this.ctx.storage.transaction(async () => {
      await this.ctx.storage.put("environment-admitted", true);
      if (!await this.ctx.storage.get("environment-lifecycle:open")) {
        await this.ctx.storage.put("environment-lifecycle:open", {
          status: "working", createdAt: record.createdAt, updatedAt: record.createdAt,
        });
      }
      await this.ctx.storage.setAlarm(await this.nextDeadline());
    });
    if (await this.ctx.storage.get("environment-close-requested") === true) {
      await this.requestClose(record.ownerId);
      throw new Error("ENVIRONMENT_CLOSING");
    }
    return { ...record, admitted: true };
  }

  /** Consume dispatch permission durably before any external workflow request. */
  async beginDispatch(ownerId: string): Promise<"send" | "already-issued"> {
    return this.ctx.storage.transaction(async () => {
      const record = await this.creation.read(ownerId);
      if (await this.ctx.storage.get("environment-close-requested") === true) {
        throw new Error("ENVIRONMENT_CLOSING");
      }
      if (await this.ctx.storage.get("environment-admitted") !== true) {
        throw new Error("ENVIRONMENT_NOT_ADMITTED");
      }
      if (await this.ctx.storage.get("environment-dispatch-issued") === true) return "already-issued";
      if (record.admitUntil <= Date.now()) throw new Error("ENVIRONMENT_ADMISSION_EXPIRED");
      await this.ctx.storage.put("environment-dispatch-issued", true);
      return "send";
    });
  }

  async requestClose(ownerId: string): Promise<"closing" | "closed" | null> {
    const status = await this.ctx.storage.transaction<"closing" | "closed" | "release" | null>(async () => {
      if (!await this.findRetainedCreation(ownerId)) return null;
      const closed = await this.ctx.storage.get("environment-capacity-released") === true;
      if (!await this.ctx.storage.get("environment-lifecycle:close")) {
        const now = Date.now();
        await this.ctx.storage.put("environment-lifecycle:close", {
          status: closed ? "completed" : "working", createdAt: now, updatedAt: now,
        });
      }
      if (closed) return "closed";
      await this.ctx.storage.put("environment-close-requested", true);
      if (await this.ctx.storage.get("environment-dispatch-rejected") === true ||
          (await this.ctx.storage.get("environment-admitted") === true &&
           await this.ctx.storage.get("environment-dispatch-issued") !== true)) return "release";
      return "closing";
    });
    if (status === null) return null;
    this.environmentChanged();
    if (status === "release") {
      return this.releaseCapacity(await this.creation.read(ownerId));
    }
    if (status === "closing") await this.deliverRuntimeMessage();
    return status;
  }

  async dispatchExecution(ownerId: string, token: string): Promise<"accepted" | "unknown" | "rejected" | "already-issued"> {
    if (await this.beginDispatch(ownerId) === "already-issued") return "already-issued";
    const creation = await this.creation.read(ownerId);
    const outcome = await dispatchEnvironmentWorkflow(this.env, token, creation.environmentId);
    if (outcome.status === "accepted") {
      await this.ctx.storage.put("environment-dispatched-run", outcome.runId);
      if (creation.admitUntil <= Date.now() || await this.ctx.storage.get("environment-close-requested") === true) {
        await this.closeExecution(ownerId, token);
      }
      return "accepted";
    }
    if (outcome.status !== "rejected") return outcome.status;
    const rejected = await this.ctx.storage.transaction(async () => {
      // A verified claim is stronger evidence than a contradictory HTTP rejection.
      if (await this.ctx.storage.get("environment-execution")) return false;
      await this.ctx.storage.put({ "environment-dispatch-rejected": true, "environment-close-requested": true });
      return true;
    });
    if (!rejected) return "unknown";
    this.environmentChanged();
    await this.releaseCapacity(creation);
    return "rejected";
  }

  private async releaseCapacity(record: EnvironmentCreationRecord): Promise<"closed"> {
    if (await this.ctx.storage.get("environment-capacity-released") !== true) {
      await this.env.ENVIRONMENT_ADMISSION.getByName("global").releaseConfirmed(record);
      await this.ctx.storage.transaction(async () => {
        if (await this.ctx.storage.get("environment-capacity-released") === true) return;
        const expiresAt = Date.now() + RESULT_RETENTION_MS;
        const now = expiresAt - RESULT_RETENTION_MS;
        for (const kind of ["open", "close"] as const) {
          const key = `environment-lifecycle:${kind}`;
          const receipt = await this.ctx.storage.get<LifecycleReceipt>(key);
          if (receipt?.status === "working") await this.ctx.storage.put(key, { ...receipt, updatedAt: now,
            status: kind === "close" ? "completed" : receipt.cancelRequested ? "cancelled" : "failed" });
        }
        await this.ctx.storage.put({ "environment-capacity-released": true, "environment-results-expires-at": expiresAt });
        await this.ctx.storage.setAlarm(expiresAt);
      });
    }
    for (const observers of this.operationObservers.values()) for (const notify of observers) notify();
    this.environmentChanged();
    return "closed";
  }

  // Internal policy comes from the workflow contract, never from MCP input.
  async claimRuntime(value: unknown, token: string): Promise<
    { decision: "stop" } | { decision: "bound"; executor: "codex" | "grok"; deadline: number }> {
    const execution = executionSchema.parse(value);
    if (!token) throw new Error("RUNNER_IDENTITY_UNAVAILABLE");
    if (await this.bindExecution(execution) === "stop") return { decision: "stop" };
    const deadline = await this.establishRuntimeDeadline(execution.ownerId, token,
      { jobName: "Environment", jobBudgetMs: 360 * 60 * 1000, cleanupMs: 10 * 60 * 1000 });
    const result = await this.ctx.storage.transaction(async () => {
      const creation = await this.creation.read(execution.ownerId);
      if (await this.ctx.storage.get("environment-close-requested") === true || deadline <= Date.now() ||
          (await this.ctx.storage.get("environment-ready-generation") === undefined && creation.admitUntil <= Date.now())) {
        await this.ctx.storage.put("environment-close-requested", true);
        return { decision: "stop" as const };
      }
      return { decision: "bound" as const, executor: creation.executor, deadline };
    });
    this.environmentChanged();
    return result;
  }

  // Internal policy comes from the workflow contract, never from MCP input.
  async establishRuntimeDeadline(ownerId: string, token: string,
    policy: { jobName: string; jobBudgetMs: number; cleanupMs: number }): Promise<number> {
    if (!policy.jobName || !Number.isSafeInteger(policy.jobBudgetMs) ||
        !Number.isSafeInteger(policy.cleanupMs) || policy.cleanupMs <= 0 ||
        policy.jobBudgetMs <= policy.cleanupMs) throw new Error("INVALID_RUNTIME_BUDGET");
    await this.creation.read(ownerId);
    if (await this.ctx.storage.get("environment-close-requested") === true) throw new Error("ENVIRONMENT_CLOSING");
    const existing = await this.ctx.storage.get<number>("environment-runtime-deadline");
    if (existing !== undefined) return existing;
    const execution = await this.ctx.storage.get<z.infer<typeof executionSchema>>("environment-execution");
    if (!execution) throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
    const startedAt = await observeJobStart(token, execution, policy.jobName);
    const deadline = startedAt + policy.jobBudgetMs - policy.cleanupMs;
    if (!Number.isSafeInteger(deadline)) throw new Error("INVALID_RUNTIME_BUDGET");
    const established = await this.ctx.storage.transaction(async () => {
      // Close can commit while the external observation is pending.
      if (await this.ctx.storage.get("environment-close-requested") === true) throw new Error("ENVIRONMENT_CLOSING");
      const stored = await this.ctx.storage.get<number>("environment-runtime-deadline");
      if (stored !== undefined) return stored;
      await this.ctx.storage.put("environment-runtime-deadline", deadline);
      await this.ctx.storage.setAlarm(await this.nextDeadline());
      return deadline;
    });
    this.environmentChanged();
    return established;
  }

  // Internal caller must supply claims obtained from fresh, verified workflow OIDC.
  // "bound" is identity acceptance, not runtime readiness or command authorization.
  async bindExecution(value: unknown): Promise<"bound" | "stop"> {
    const execution = executionSchema.parse(value);
    if (execution.repository !== this.env.GITHUB_RUNNER_REPOSITORY) throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
    const result = await this.ctx.storage.transaction<"bound" | "stop">(async () => {
      const record = await this.creation.read(execution.ownerId);
      if (await this.ctx.storage.get("environment-dispatch-issued") !== true) {
        throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
      }
      const stored = await this.ctx.storage.get<z.infer<typeof executionSchema>>("environment-execution");
      const dispatchedRun = await this.ctx.storage.get<string>("environment-dispatched-run");
      if (dispatchedRun && (execution.runId !== dispatchedRun || execution.runAttempt !== "1")) {
        throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
      }
      if (stored && (stored.repository !== execution.repository || stored.runId !== execution.runId ||
          stored.runAttempt !== execution.runAttempt || stored.ownerId !== execution.ownerId)) {
        throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
      }
      if (!stored) await this.ctx.storage.put("environment-execution", execution);
      if ((!stored && record.admitUntil <= Date.now()) ||
          await this.ctx.storage.get("environment-close-requested") === true) {
        await this.ctx.storage.put("environment-close-requested", true);
        return "stop";
      }
      return "bound";
    });
    this.environmentChanged();
    return result;
  }

  // Invoked only after fresh OIDC verification on each transport upgrade.
  async bindRuntime(value: unknown): Promise<RuntimeBinding & { deadline: number }> {
    const claim = runtimeClaimSchema.parse(value);
    const result = await this.ctx.storage.transaction(async () => {
      const creation = await this.creation.read(claim.ownerId);
      const execution = await this.ctx.storage.get<z.infer<typeof executionSchema>>("environment-execution");
      if (!execution || execution.ownerId !== claim.ownerId || execution.repository !== claim.repository ||
          execution.runId !== claim.runId || execution.runAttempt !== claim.runAttempt) {
        throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
      }
      if (await this.ctx.storage.get("environment-close-requested") === true) throw new Error("ENVIRONMENT_CLOSING");
      const deadline = await this.ctx.storage.get<number>("environment-runtime-deadline");
      if (deadline === undefined || deadline <= Date.now()) throw new Error("ENVIRONMENT_DEADLINE_EXPIRED");
      if (await this.ctx.storage.get("environment-ready-generation") === undefined && creation.admitUntil <= Date.now()) {
        throw new Error("ENVIRONMENT_ADMISSION_EXPIRED");
      }
      const previous = await this.ctx.storage.get<RuntimeBinding>("environment-runtime");
      if (previous && previous.runtimeId !== claim.runtimeId) throw new Error("ENVIRONMENT_RUNTIME_REPLACEMENT_REJECTED");
      const generation = (previous?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("ENVIRONMENT_GENERATION_EXHAUSTED");
      const binding = { runtimeId: claim.runtimeId, generation };
      await this.ctx.storage.put("environment-runtime", binding);
      return { ...binding, deadline };
    });
    this.environmentChanged();
    return result;
  }

  // Trusted observer only: a runner's own callback is not stop confirmation.
  async confirmExecutionStopped(value: unknown): Promise<"closed"> {
    const execution = executionSchema.parse(value);
    const record = await this.ctx.storage.transaction(async () => {
      const creation = await this.creation.read(execution.ownerId);
      const stored = await this.executionForObservation(execution.ownerId);
      if (!stored || stored.repository !== execution.repository || stored.runId !== execution.runId ||
          stored.runAttempt !== execution.runAttempt || stored.ownerId !== execution.ownerId) {
        throw new Error("ENVIRONMENT_EXECUTION_REJECTED");
      }
      await this.ctx.storage.put("environment-close-requested", true);
      await this.ctx.storage.put("environment-stop-confirmed", true);
      const taskId = await this.ctx.storage.get<string>("environment-active-operation");
      if (taskId) {
        const key = `environment-operation:${taskId}`;
        const operation = await this.ctx.storage.get<OperationRecord>(key);
        if (!operation) throw new Error("ENVIRONMENT_OPERATION_NOT_FOUND");
        if (operation.result === undefined) {
          await this.ctx.storage.put(key, { ...operation, updatedAt: Date.now(),
            result: { ok: false, code: "ENVIRONMENT_ENDED_OUTCOME_UNKNOWN" } });
        }
        await this.ctx.storage.delete("environment-active-operation");
      }
      return { creation, taskId };
    });
    if (record.taskId) {
      for (const notify of this.operationObservers.get(record.taskId) ?? []) notify();
    }
    this.environmentChanged();
    return this.releaseCapacity(record.creation);
  }

  // Token must come from the authenticated Principal's current Actions authority.
  async closeExecution(ownerId: string, token: string): Promise<"closing" | "closed"> {
    if (await this.requestClose(ownerId) === "closed") return "closed";
    const execution = await this.executionForObservation(ownerId);
    if (!execution) return "closing"; // A late claim retains the cleanup obligation.
    if (await this.ctx.storage.get("environment-stop-confirmed") === true) return this.confirmExecutionStopped(execution);
    const stopped = await requestWorkflowStop(token, execution, ENVIRONMENT_WORKFLOW);
    if (stopped === "completed") return this.confirmExecutionStopped(execution);
    return await this.observeStop(ownerId, token) === "closed" ? "closed" : "closing";
  }

  // Token must come from the authenticated Principal's current Actions authority.
  async observeStop(ownerId: string, token: string): Promise<"unbound" | "not-stopped" | "closed"> {
    await this.creation.read(ownerId);
    const execution = await this.executionForObservation(ownerId);
    if (!execution) return "unbound";
    if (await this.ctx.storage.get("environment-stop-confirmed") === true) {
      return this.confirmExecutionStopped(execution);
    }
    const observed = await observeWorkflowExecution(token, execution, ENVIRONMENT_WORKFLOW);
    if (observed.status !== "completed") return "not-stopped";
    return this.confirmExecutionStopped(execution);
  }

  private async executionForObservation(ownerId: string): Promise<z.infer<typeof executionSchema> | undefined> {
    const bound = await this.ctx.storage.get<z.infer<typeof executionSchema>>("environment-execution");
    if (bound) return bound;
    const runId = await this.ctx.storage.get<string>("environment-dispatched-run");
    return runId ? { ownerId, repository: this.env.GITHUB_RUNNER_REPOSITORY, runId, runAttempt: "1" } : undefined;
  }
}

export class EnvironmentAdmissionObject extends DurableObject<Bindings> {
  private readonly admission: EnvironmentAdmission;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.admission = new EnvironmentAdmission(ctx.storage);
  }

  // Membership only. Callers must read each Environment's current lifecycle.
  async held(): Promise<string[]> {
    if (!this.ctx.id.equals(this.env.ENVIRONMENT_ADMISSION.idFromName("global"))) {
      throw new Error("ENVIRONMENT_ADMISSION_ID_MISMATCH");
    }
    return this.admission.held();
  }

  async list(ownerId: string): Promise<string[]> {
    if (!this.ctx.id.equals(this.env.ENVIRONMENT_ADMISSION.idFromName("global"))) {
      throw new Error("ENVIRONMENT_ADMISSION_ID_MISMATCH");
    }
    return this.admission.list(ownerId);
  }

  async reserve(record: EnvironmentCreationRecord): Promise<AdmissionResult> {
    if (!this.ctx.id.equals(this.env.ENVIRONMENT_ADMISSION.idFromName("global"))) {
      throw new Error("ENVIRONMENT_ADMISSION_ID_MISMATCH");
    }
    return this.admission.reserve(record.ownerId, record.environmentId, record.admitUntil);
  }

  async releaseConfirmed(record: EnvironmentCreationRecord): Promise<void> {
    if (!this.ctx.id.equals(this.env.ENVIRONMENT_ADMISSION.idFromName("global"))) {
      throw new Error("ENVIRONMENT_ADMISSION_ID_MISMATCH");
    }
    await this.admission.releaseConfirmed(record.ownerId, record.environmentId);
  }
}
