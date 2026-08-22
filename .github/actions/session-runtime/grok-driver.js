const { EventSink, bounded } = require("./events.js");
const { JsonRpcError, JsonRpcProcess } = require("./json-rpc.js");

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
    this.rpc = this.createProcess({
      cwd: this.workingDirectory,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.nativeRequest(method, params),
      onExit: () => this.failed(),
    });
    const initialized = await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "harness-runner", title: "Harness Runner", version: "1.0.0" },
    });
    if (initialized.protocolVersion !== 1) throw new Error("Grok ACP v1 is unavailable");
    await this.requireInterject();
    const started = await this.rpc.request("session/new", {
      cwd: this.workingDirectory,
      mcpServers: [],
    });
    this.nativeSessionId = started.sessionId;
    if (!validNativeId(this.nativeSessionId)) throw new Error("Grok session/new contract is unavailable");
    this.transition({ type: "admit" });
    if (payload.turnId && payload.text) {
      this.transition({ type: "begin_turn", turnId: payload.turnId });
      this.startTurn(payload.turnId, payload.text);
    }
  }

  async requireInterject() {
    try {
      await this.rpc.request("_x.ai/interject", {
        // Invalid parameters probe method availability without targeting a Session.
      });
    } catch (error) {
      if (!(error instanceof JsonRpcError) || error.code === -32601) {
        throw new Error("Grok x.ai/interject capability is unavailable");
      }
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
    this.rpc.request("session/prompt", {
      sessionId: this.nativeSessionId,
      prompt: [{ type: "text", text }],
    }).then(
      (result) => this.completeTurn(result.stopReason),
      () => this.failTurn(),
    );
  }

  async steer(turnId, text) {
    this.requireActive(turnId);
    const result = await this.rpc.request("_x.ai/interject", {
      sessionId: this.nativeSessionId,
      text,
      interjectionId: `${this.sessionId}:${turnId}`,
    });
    if (result.status !== "queued") throw new Error("Grok interject contract is unavailable");
  }

  interrupt(turnId) {
    this.requireActive(turnId);
    this.cancelRequests();
    this.rpc.notify("session/cancel", { sessionId: this.nativeSessionId });
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
    if (method !== "session/update" || params.sessionId !== this.nativeSessionId || !this.harnessTurnId) {
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
        params.sessionId !== this.nativeSessionId || !this.harnessTurnId) {
      throw new Error("Unsupported Grok client request");
    }
    const choices = (Array.isArray(params.options) ? params.options : [])
      .filter((option) => option && typeof option === "object" &&
        validPublicId(option.optionId) && bounded(option.name))
      .slice(0, 50)
      .map(({ optionId, name }) => ({ choiceId: optionId, label: bounded(name) }));
    if (choices.length === 0) throw new Error("Grok permission request has no supported choice");
    const requestId = `request-${this.nextRequestId++}`;
    return new Promise((resolve) => {
      this.requests.set(requestId, { choices: new Set(choices.map(({ choiceId }) => choiceId)), resolve });
      this.transition({
        type: "wait_for_user",
        turnId: this.harnessTurnId,
        request: {
          requestId,
          state: "open",
          kind: "permission",
          title: bounded(params.toolCall?.title) ?? "Permission required",
          detail: bounded(params.toolCall?.kind),
          choices,
        },
      });
    });
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
    this.rpc?.stop();
  }
}

function createGrokProcess(options) {
  return new JsonRpcProcess({
    command: "grok",
    args: ["--always-approve", "agent", "--no-leader", "stdio"],
    ...options,
  });
}

function validNativeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validPublicId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function grokTurnStatus(stopReason) {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return "interrupted";
  return "failed";
}

module.exports = { GrokDriver, createGrokProcess };
