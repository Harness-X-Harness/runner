const { EventSink, bounded } = require("./events.js");
const { GrokClient, createGrokProcess } = require("../agent-runtime/grok-client.js");
const { grokApproval } = require("../agent-runtime/approvals.js");

class GrokDriver {
  constructor({ sessionId, workingDirectory, emit, transition, createProcess = createGrokProcess }) {
    this.sessionId = sessionId;
    this.workingDirectory = workingDirectory;
    this.emit = emit;
    this.transition = transition;
    this.createProcess = createProcess;
    this.requests = new Map();
    this.nextRequestId = 1;
    this.events = new EventSink({ emit });
  }

  async start(payload) {
    this.client = new GrokClient({
      workingDirectory: this.workingDirectory,
      createProcess: this.createProcess,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.nativeRequest(method, params),
      onExit: () => this.failed(),
    });
    await this.client.initialize({ interject: true });
    this.transition({ type: "admit" });
    if (payload.turnId && payload.text) {
      this.transition({ type: "begin_turn", turnId: payload.turnId });
      this.startTurn(payload.turnId, payload.text);
    }
  }

  async execute(command) {
    switch (command.kind) {
      case "start":
      case "start_queued":
        this.startTurn(command.payload.turnId, command.payload.text);
        return;
      case "steer":
        return this.steer(command.payload.turnId, command.payload.text);
      case "interrupt":
        return this.interrupt(command.payload.turnId);
      case "response":
        return this.respond(command.payload);
      case "stop":
        this.stop();
        this.transition({ type: "terminate", reason: "stopped" });
        return;
      default:
        throw new Error("Unsupported Grok Session command");
    }
  }

  startTurn(turnId, text) {
    if (this.harnessTurnId) throw new Error("Grok turn is already active");
    this.harnessTurnId = turnId;
    this.client.startTurn(text).then(
      (result) => this.completeTurn(result.stopReason),
      () => this.failTurn(),
    );
  }

  async steer(turnId, text) {
    this.requireActive(turnId);
    await this.client.steer(text, `${this.sessionId}:${turnId}`);
  }

  interrupt(turnId) {
    this.requireActive(turnId);
    this.cancelRequests();
    this.client.interrupt();
  }

  respond(payload) {
    const pending = this.requests.get(payload.requestId);
    if (!pending || !pending.choices.has(payload.choiceId)) {
      throw new Error("Grok permission response is not allowed");
    }
    this.requests.delete(payload.requestId);
    pending.resolve({ outcome: { outcome: "selected", optionId: payload.choiceId } });
  }

  notification(method, params) {
    if (method !== "session/update" || !this.harnessTurnId) {
      return;
    }
    const update = params.update;
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.events.text(this.harnessTurnId, update.content?.text);
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.events.event({
        type: "activity",
        data: {
          turnId: this.harnessTurnId,
          label: bounded(update.title) ?? "Tool",
          target: bounded(update.kind),
          status: bounded(update.status) ?? (update.sessionUpdate === "tool_call" ? "running" : "updated"),
        },
      });
    }
  }

  nativeRequest(method, params) {
    if (method !== "session/request_permission" ||
        !this.harnessTurnId) {
      throw new Error("Unsupported Grok client request");
    }
    return grokApproval(params);
  }

  completeTurn(stopReason) {
    if (this.terminated || !this.harnessTurnId) return;
    const turnId = this.harnessTurnId;
    this.events.flush(turnId);
    this.harnessTurnId = undefined;
    this.cancelRequests();
    this.transition({
      type: "complete_turn",
      turnId,
      status: grokTurnStatus(stopReason),
    });
  }

  failTurn() {
    if (this.terminated || !this.harnessTurnId) return;
    const turnId = this.harnessTurnId;
    this.events.flush(turnId);
    this.harnessTurnId = undefined;
    this.cancelRequests();
    this.emit({
      type: "error",
      data: { scope: "driver", code: "turn_failed", message: "The Grok turn failed." },
    });
    this.transition({ type: "complete_turn", turnId, status: "failed" });
  }

  cancelRequests() {
    for (const request of this.requests.values()) {
      request.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.requests.clear();
  }

  requireActive(turnId) {
    if (!this.harnessTurnId || this.harnessTurnId !== turnId) {
      throw new Error("Grok active turn mismatch");
    }
  }

  failed() {
    if (this.terminated) return;
    this.terminated = true;
    this.events.close();
    this.emit({
      type: "error",
      data: { scope: "driver", code: "driver_ended", message: "The Grok driver ended." },
    });
    this.transition({ type: "terminate", reason: "driver_failed" });
  }

  stop() {
    this.terminated = true;
    this.events.close();
    this.cancelRequests();
    this.client?.stop();
  }
}

function grokTurnStatus(stopReason) {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return "interrupted";
  return "failed";
}

module.exports = { GrokDriver };
