import type { ActiveSession, SessionNotification, PromptResponse } from "@agentclientprotocol/sdk";
import { grokBoundary } from "./grok-notifications.ts";
import { TaskError } from "../../../shared/task-errors.ts";

// Selection only. The ACP SDK owns transport, and the caller owns prompt lifetime.
export class FinalResponse {
  private text = "";
  private messageId: string | null | undefined;
  private lastResponse: string | undefined;
  private completed = false;
  private stopReason: string | null | undefined;

  private readonly executor: "codex" | "grok";
  private readonly sessionId: string;
  constructor(executor: "codex" | "grok", sessionId: string) {
    this.executor = executor;
    this.sessionId = sessionId;
  }

  update(notification: SessionNotification) {
    if (notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    if (this.executor === "grok" && update.sessionUpdate === "session_info_update" &&
        update._meta?.["harness/grok-response"] !== undefined) {
      const boundary = grokBoundary.parse(update._meta["harness/grok-response"]);
      if (boundary.sessionUpdate === "response_completed") {
        this.lastResponse = this.text;
        this.text = "";
        this.completed = true;
        this.stopReason = boundary.stop_reason;
      } else {
        if (this.text) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
        this.completed = false;
      }
    }
    if (this.executor === "codex" && update.sessionUpdate === "tool_call") {
      this.text = "";
      this.messageId = undefined;
    }
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return;
    if (this.executor === "codex") {
      const metadata = update._meta?.codex;
      const phase = metadata && typeof metadata === "object" && "phase" in metadata ? metadata.phase : undefined;
      if (phase !== undefined && phase !== null && phase !== "commentary" && phase !== "final_answer") {
        throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      }
      if (!update.messageId) return; // Adapter notices are not a completed Agent message.
      if (update.messageId !== this.messageId) {
        this.text = "";
        this.messageId = update.messageId;
      }
      if (phase === "commentary") { this.text = ""; return; }
    }
    this.text += update.content.text;
    this.completed = false;
  }

  finish(result: PromptResponse): string {
    if (!["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(result.stopReason)) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    if (result.stopReason !== "end_turn") throw new TaskError("PROVIDER_EXECUTION_ERROR");
    if (this.executor === "grok" && (!this.completed || this.text ||
        (this.stopReason != null && !["end_turn", "stop", "completed"].includes(this.stopReason)))) {
      throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    }
    const text = this.executor === "grok" ? this.lastResponse : this.text;
    if (!text?.trim()) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    return text;
  }
}

export async function readFinalResponse(session: ActiveSession, executor: "codex" | "grok"): Promise<string> {
  const result = await readAgentTurn(session, executor);
  if (result.status === "cancelled") throw new TaskError("PROVIDER_EXECUTION_ERROR");
  return result.finalResponse;
}

// Environment turns retain native cancellation as a result, not session failure.
export async function readAgentTurn(session: ActiveSession, executor: "codex" | "grok", onUpdate?: (notification: SessionNotification) => Promise<void>):
Promise<{ status: "completed"; finalResponse: string } | { status: "cancelled" }> {
  const final = new FinalResponse(executor, session.sessionId);
  for (;;) {
    const message = await session.nextUpdate();
    if (message.kind === "stop") {
      if (message.response.stopReason === "cancelled") return { status: "cancelled" };
      return { status: "completed", finalResponse: final.finish(message.response) };
    }
    await onUpdate?.(message.notification);
    final.update(message.notification);
  }
}
