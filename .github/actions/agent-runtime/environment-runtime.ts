import { methods, type ActiveSession, type ClientContext } from "@agentclientprotocol/sdk";
import { CommandCleanupError, runCommand, type CommandContext, type CommandInput } from "./command.ts";
import { readAgentTurn } from "./final-response.ts";

/** One shared local slot. The caller owns the enclosing ACP process scope. */
export class EnvironmentRuntime {
  private readonly context: Omit<CommandContext, "signal">;
  private active?: { cancel: () => Promise<void>; result: Promise<unknown> };
  private closing?: Promise<void>;
  private cleanupFailure?: Error;

  constructor(context: Omit<CommandContext, "signal">) {
    this.context = { ...context, env: { ...context.env } };
  }

  command(input: CommandInput) {
    const controller = new AbortController();
    return this.execute(() => runCommand(input, { ...this.context, signal: controller.signal }),
      async () => { controller.abort(); });
  }

  agent(client: ClientContext, session: ActiveSession, executor: "codex" | "grok", prompt: string) {
    let cancelRequested = false;
    const cancel = () => client.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
    return this.execute(async () => {
      if (!prompt.trim()) throw new Error("INVALID_AGENT_PROMPT");
      if (Date.now() >= this.context.deadline) throw new Error("ENVIRONMENT_DEADLINE_EXPIRED");
      const results = await Promise.allSettled([session.prompt(prompt), readAgentTurn(session, executor, async notification => {
        // A native update proves the prompt reached the agent. Reassert an early
        // cancellation that may have arrived before its handler was installed.
        if (cancelRequested) await cancel();
        const update = notification.update;
        if (notification.sessionId === session.sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          this.context.onOutput?.(update.content.text);
        }
      })]);
      // Both the prompt and its update consumer must finish before releasing the slot.
      for (const result of results) {
        if (result.status === "rejected") {
          this.cleanupFailure = new Error("AGENT_TURN_UNCONFIRMED");
          throw result.reason;
        }
      }
      const result = results[1];
      if (result.status !== "fulfilled") throw new Error("AGENT_TURN_UNCONFIRMED");
      return result.value;
    }, () => { cancelRequested = true; return cancel(); });
  }

  private execute<T>(start: () => Promise<T>, cancel: () => Promise<void>): Promise<T> {
    if (this.closing || this.cleanupFailure) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_CLOSING"));
    if (this.active) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_BUSY"));
    const result = Promise.resolve().then(start).catch((error: unknown) => {
      if (error instanceof CommandCleanupError) this.cleanupFailure = error;
      throw error;
    }).finally(() => { this.active = undefined; });
    this.active = { cancel, result };
    return result;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const active = this.active;
    this.closing = Promise.resolve().then(async () => {
      await active?.cancel();
      try { await active?.result; }
      catch (error) { if (error instanceof CommandCleanupError) throw error; }
      if (this.cleanupFailure) throw this.cleanupFailure;
    });
    return this.closing;
  }

  async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await active.cancel();
    try { await active.result; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "COMMAND_CANCELLED_BEFORE_START") throw error;
    }
  }
}
