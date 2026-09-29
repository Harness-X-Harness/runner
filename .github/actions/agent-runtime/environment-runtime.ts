import { methods, type ActiveSession, type ClientContext } from "@agentclientprotocol/sdk";
import { AGENT_MODEL_DEFAULTS, applyAgentSelection, resolveAgentSelection, type AgentModelReport, type AgentSelection } from "./agent-model.ts";
import { CommandCleanupError, runCommand, type CommandContext, type CommandInput } from "./command.ts";
import { readAgentTurn } from "./final-response.ts";

type RuntimeContext = Omit<CommandContext, "signal"> & {
  readAgentReport?: (executor: "codex" | "grok", signal: AbortSignal) => Promise<AgentModelReport>;
};
export type AgentTurn = { prompt: string; model?: string; reasoningEffort?: string };

/** One shared local slot. The caller owns the enclosing ACP process scope. */
export class EnvironmentRuntime {
  private readonly context: Omit<CommandContext, "signal">;
  private readonly readAgentReport?: RuntimeContext["readAgentReport"];
  private active?: { cancel: () => Promise<void>; result: Promise<unknown> };
  private closing?: Promise<void>;
  private cleanupFailure?: Error;
  private locked?: AgentSelection;
  private applied?: AgentSelection;
  private agentConfigUncertain = false;

  constructor(context: RuntimeContext) {
    const { readAgentReport, ...rest } = context;
    this.readAgentReport = readAgentReport;
    this.context = { ...rest, env: { ...rest.env } };
  }

  command(input: CommandInput) {
    const controller = new AbortController();
    return this.execute(() => runCommand(input, { ...this.context, signal: controller.signal }),
      async () => { controller.abort(); });
  }

  agent(client: ClientContext, session: ActiveSession, executor: "codex" | "grok", input: string | AgentTurn) {
    const turn = typeof input === "string" ? { prompt: input } : input;
    let cancelRequested = false;
    const selectionAbort = new AbortController();
    const cancel = () => {
      selectionAbort.abort();
      return client.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
    };
    return this.execute(async () => {
      if (!turn.prompt.trim()) throw new Error("INVALID_AGENT_PROMPT");
      if (Date.now() >= this.context.deadline) throw new Error("ENVIRONMENT_DEADLINE_EXPIRED");
      const selection = await this.selectModel(executor, turn, selectionAbort.signal, async (configId, value) => {
        await client.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId, value });
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === "AGENT_TURN_CANCELLED") return undefined;
        throw error;
      });
      if (!selection) return { status: "cancelled" as const };
      const results = await Promise.allSettled([session.prompt(turn.prompt), readAgentTurn(session, executor, async notification => {
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
      if (result.value.status === "cancelled") return result.value;
      return { ...result.value, model: selection.model, reasoningEffort: selection.reasoningEffort };
    }, () => { cancelRequested = true; return cancel(); });
  }

  private async selectModel(executor: "codex" | "grok", turn: AgentTurn, signal: AbortSignal,
    setOption: (configId: "model" | "reasoning_effort", value: string) => Promise<void>): Promise<AgentSelection> {
    if (this.agentConfigUncertain) throw new Error("AGENT_MODEL_UNCERTAIN");
    const requested = { model: turn.model, reasoningEffort: turn.reasoningEffort };
    const explicit = requested.model !== undefined || requested.reasoningEffort !== undefined;
    if (this.locked && !explicit) return this.locked;
    if (!this.readAgentReport) {
      if (explicit) throw new Error("AGENT_MODEL_UNAVAILABLE");
      const selection = AGENT_MODEL_DEFAULTS[executor];
      this.locked = this.applied = selection;
      return selection;
    }
    let selection: AgentSelection;
    try {
      if (signal.aborted) throw new Error("AGENT_TURN_CANCELLED");
      selection = resolveAgentSelection({ executor, report: await this.readAgentReport(executor, signal), requested, locked: this.locked });
    } catch (error) {
      if (signal.aborted) throw new Error("AGENT_TURN_CANCELLED");
      if (error instanceof Error && (error.message === "AGENT_MODEL_REJECTED" || error.message === "AGENT_MODEL_CONFLICT" || error.message === "AGENT_MODEL_UNAVAILABLE")) throw error;
      throw new Error("AGENT_MODEL_REJECTED");
    }
    let started = false;
    try {
      await applyAgentSelection(this.applied ?? AGENT_MODEL_DEFAULTS[executor], selection, async (configId, value) => {
        started = true;
        await setOption(configId, value);
      });
    } catch (error) {
      if (started) this.agentConfigUncertain = true;
      if (signal.aborted) throw new Error("AGENT_TURN_CANCELLED");
      if (started) throw new Error("AGENT_MODEL_UNCERTAIN");
      if (error instanceof Error && error.message === "AGENT_TURN_CANCELLED") throw error;
      throw new Error("AGENT_MODEL_REJECTED");
    }
    this.applied = this.locked = selection;
    return selection;
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
