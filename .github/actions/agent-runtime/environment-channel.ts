import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import type { EnvironmentPort } from "./environment.ts";
import type { RuntimeConnection } from "./environment-connection.ts";
import { setTimeout as delay } from "node:timers/promises";
import { githubRunCompletion } from "./github-run-contract.ts";

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ci-accepted"), generation: z.number().int().positive(), taskId: z.string(), waitId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("ci-result"), generation: z.number().int().positive(), taskId: z.string(), waitId: z.string().uuid(), result: githubRunCompletion }).strict(),
  z.object({ type: z.literal("ci-rejected"), generation: z.number().int().positive(), taskId: z.string(), waitId: z.string().uuid(),
    code: z.enum(["CI_EVENT_COVERAGE_REQUIRED", "CI_WAIT_TASK_NOT_ACTIVE", "CI_WAIT_CAPACITY", "CI_WAIT_ID_CONFLICT"]) }).strict(),
  z.object({ type: z.literal("ready-accepted") }).strict(),
  z.object({ type: z.literal("input-accepted"), generation: z.number().int().positive(),
    taskId: z.string(), inputId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("output-accepted"), generation: z.number().int().positive(),
    taskId: z.string(), revision: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("input-response"), generation: z.number().int().positive(),
    taskId: z.string(), inputId: z.string().uuid(), response: z.unknown() }).strict(),
  z.object({ type: z.literal("execute"), generation: z.number().int().positive(),
    taskId: z.string().regex(/^[\w-]{1,128}$/), input: z.unknown() }).strict(),
  z.object({ type: z.literal("close"), generation: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("cancel"), generation: z.number().int().positive(),
    taskId: z.string().regex(/^[\w-]{1,128}$/) }).strict(),
  z.object({ type: z.literal("result-accepted"), generation: z.number().int().positive(),
    taskId: z.string().regex(/^[\w-]{1,128}$/) }).strict(),
]);

/** Reconnect transport only. The caller retains one Environment and one runtime ID. */
export async function serveEnvironmentConnections(environment: EnvironmentPort, deadline: number,
  connect: (signal: AbortSignal) => Promise<RuntimeConnection>): Promise<void> {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || remaining > 2_147_483_647) throw new Error("INVALID_ENVIRONMENT_DEADLINE");
  if (remaining <= 0) { await environment.close(); return; }
  const signal = AbortSignal.any([environment.signal, AbortSignal.timeout(remaining)]);
  let generation = 0;
  try {
    while (!signal.aborted) {
      let connection: RuntimeConnection | undefined;
      try {
        connection = await connect(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      } catch {
        if (signal.aborted) break;
        await delay(1000, undefined, { signal }).catch(() => {});
        continue;
      }
      try {
        if (connection.deadline !== deadline || connection.generation <= generation) {
          throw new Error("ENVIRONMENT_CONNECTION_IDENTITY_CHANGED");
        }
        generation = connection.generation;
        const abort = () => connection.socket.terminate();
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) break;
          await serveEnvironmentConnection(connection, environment, () => generation);
        } finally { signal.removeEventListener("abort", abort); }
        if ((await connection.closed).code === 1008 && !signal.aborted) throw new Error("ENVIRONMENT_CONNECTION_REJECTED");
      } finally { connection.socket.terminate(); }
      if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => {});
    }
  } finally { await environment.close(); }
}

/** A socket scope only; the Environment and its receipts survive disconnection. */
export async function serveEnvironmentConnection(connection: RuntimeConnection, environment: EnvironmentPort,
  currentGeneration: () => number): Promise<void> {
  const { socket, generation } = connection;
  const pending = new Set<Promise<void>>();
  let ready = false;
  const reject = () => socket.close(1008, "Runtime message rejected");
  const stopped = () => socket.close(1000);
  const outputRevisions = new Map<string, number>();
  let sendingOutput: { taskId: string; revision: number } | undefined;
  const publishOutput = () => {
    if (!ready || sendingOutput || socket.readyState !== WebSocket.OPEN || currentGeneration() !== generation) return;
    const next = environment.output.entries().find(({ taskId, output }) => output.revision > (outputRevisions.get(taskId) ?? -1));
    if (!next) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
    sendingOutput = { taskId: next.taskId, revision: next.output.revision };
    socket.send(JSON.stringify({ type: "output", generation, ...next }));
  };
  const publishInputs = () => {
    if (!ready || socket.readyState !== WebSocket.OPEN || currentGeneration() !== generation) return;
    for (const input of environment.inputs.pending()) {
      if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
      socket.send(JSON.stringify({ type: "input", generation, ...input }));
    }
  };
  const receive = (bytes: RawData, binary: boolean) => {
    if (binary || environment.signal.aborted || currentGeneration() !== generation) return reject();
    let value: unknown;
    try { value = JSON.parse(bytes.toString()); } catch { return reject(); }
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success) return reject();
    const message = parsed.data;
    if (message.type === "ready-accepted") { ready = true; publishInputs(); publishOutput(); publishCi(); return; }
    if (!ready || message.generation !== generation) return reject();
    if (message.type === "result-accepted") return; // Retain replay protection for this runtime's lifetime.
    if (message.type === "input-accepted") return;
    if (message.type === "ci-accepted" || message.type === "ci-result" || message.type === "ci-rejected") {
      try {
        if (message.type === "ci-accepted") environment.ciWaits.accept(message.taskId, message.waitId);
        else if (message.type === "ci-result") environment.ciWaits.complete(message.taskId, message.waitId, message.result);
        else environment.ciWaits.reject(message.taskId, message.waitId, message.code);
      } catch { reject(); }
      return;
    }
    if (message.type === "output-accepted") {
      if (sendingOutput?.taskId !== message.taskId || sendingOutput.revision !== message.revision) return reject();
      outputRevisions.set(message.taskId, message.revision);
      sendingOutput = undefined;
      publishOutput();
      return;
    }
    if (message.type === "input-response") {
      try { environment.inputs.answer(message.taskId, message.inputId, message.response); }
      catch { reject(); }
      return;
    }
    if (message.type === "close") {
      void environment.close().catch(() => socket.terminate());
      return;
    }
    if (message.type === "cancel") {
      void environment.cancel(message.taskId).catch(reject);
      return;
    }
    if (pending.size >= 32) return reject();
    const delivery = environment.execute(message.taskId, message.input).then(result => {
      if (socket.readyState !== WebSocket.OPEN || currentGeneration() !== generation) return;
      if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
      socket.send(JSON.stringify({ type: "result", generation, taskId: message.taskId, result,
        output: environment.output.read(message.taskId) }));
    }).catch(reject).finally(() => { pending.delete(delivery); });
    pending.add(delivery);
  };
  socket.on("message", receive);
  const publishCi = () => {
    if (!ready || socket.readyState !== WebSocket.OPEN || currentGeneration() !== generation) return;
    for (const pending of environment.ciWaits.pending()) {
      if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
      const { taskId, waitId, target, observation } = pending;
      socket.send(JSON.stringify(observation ? { type: "ci-observed", generation, taskId, waitId, result: observation }
        : { type: "ci-register", generation, taskId, waitId, target }));
    }
  };
  const unsubscribeCi = environment.ciWaits.subscribe(publishCi);
  const unsubscribeInputs = environment.inputs.subscribe(publishInputs);
  const unsubscribeOutput = environment.output.subscribe(publishOutput);
  environment.signal.addEventListener("abort", stopped, { once: true });
  try {
    if (environment.signal.aborted) stopped();
    else socket.send(JSON.stringify({ type: "ready" }));
    await connection.closed;
  } finally {
    socket.off("message", receive);
    unsubscribeInputs();
    unsubscribeOutput();
    unsubscribeCi();
    environment.signal.removeEventListener("abort", stopped);
    // Pending execution belongs to EnvironmentOperations, not this dead socket.
  }
}
