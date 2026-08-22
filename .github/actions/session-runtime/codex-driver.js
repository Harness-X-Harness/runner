const { EventSink, bounded } = require("./events.js");
const { JsonRpcProcess } = require("./json-rpc.js");

const APPROVAL_METHODS = new Map([
  ["item/commandExecution/requestApproval", "command"],
  ["item/fileChange/requestApproval", "file_change"],
]);

class CodexDriver {
  constructor({ sessionId, workingDirectory, emit, transition, createProcess = createCodexProcess }) {
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
      clientInfo: {
        name: "harness-runner",
        title: "Harness Runner",
        version: "1.0.0",
      },
      capabilities: {},
    });
    if (typeof initialized.userAgent !== "string" || initialized.userAgent.length === 0) {
      throw new Error("Codex App Server contract is unavailable");
    }
    this.rpc.notify("initialized", {});
    const started = await this.rpc.request("thread/start", { cwd: this.workingDirectory });
    this.threadId = started.thread?.id;
    if (!validNativeId(this.threadId)) throw new Error("Codex thread/start contract is unavailable");
    this.transition({ type: "admit" });
    if (payload.turnId && payload.text) {
      this.transition({ type: "begin_turn", turnId: payload.turnId });
      await this.startTurn(payload.turnId, payload.text);
    }
  }

  async execute(command) {
    switch (command.kind) {
      case "start":
      case "start_queued":
        return this.startTurn(command.payload.turnId, command.payload.text);
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
        throw new Error("Unsupported Codex Session command");
    }
  }

  async startTurn(turnId, text) {
    if (this.harnessTurnId) throw new Error("Codex turn is already active");
    this.harnessTurnId = turnId;
    try {
      const result = await this.rpc.request("turn/start", {
        threadId: this.threadId,
        clientUserMessageId: turnId,
        input: [{ type: "text", text }],
      });
      const nativeTurnId = result.turn?.id;
      if (!validNativeId(nativeTurnId)) throw new Error("Codex turn/start contract is unavailable");
      if (this.nativeTurnId && this.nativeTurnId !== nativeTurnId) {
        throw new Error("Codex active turn identity changed");
      }
      this.nativeTurnId = nativeTurnId;
    } catch {
      if (this.terminated) return;
      const failedTurnId = this.harnessTurnId;
      this.harnessTurnId = undefined;
      this.nativeTurnId = undefined;
      this.emit({
        type: "error",
        data: { scope: "driver", code: "turn_failed", message: "The Codex turn failed." },
      });
      this.transition({ type: "complete_turn", turnId: failedTurnId, status: "failed" });
    }
  }

  async steer(turnId, text) {
    this.requireActive(turnId);
    const result = await this.rpc.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.nativeTurnId,
      clientUserMessageId: `${turnId}:steer`,
      input: [{ type: "text", text }],
    });
    if (result.turnId !== this.nativeTurnId) throw new Error("Codex steer targeted another turn");
  }

  async interrupt(turnId) {
    this.requireActive(turnId);
    this.cancelRequests();
    await this.rpc.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.nativeTurnId,
    });
  }

  async respond(payload) {
    const pending = this.requests.get(payload.requestId);
    if (!pending) throw new Error("Codex request is not pending");
    this.requests.delete(payload.requestId);
    if (pending.kind === "input") {
      pending.resolve({ answers: payload.answers ?? {} });
      return;
    }
    if (!pending.choices.has(payload.choiceId)) throw new Error("Codex response is not allowed");
    if (pending.kind === "permissions") {
      pending.resolve(payload.choiceId === "deny"
        ? { permissions: {} }
        : {
            permissions: pending.permissions,
            scope: payload.choiceId === "allow-session" ? "session" : "turn",
          });
      return;
    }
    pending.resolve({ decision: payload.choiceId });
  }

  notification(method, params) {
    if (method === "turn/started" && this.harnessTurnId && params.threadId === this.threadId) {
      const turnId = params.turn?.id;
      if (validNativeId(turnId)) {
        if (this.nativeTurnId && this.nativeTurnId !== turnId) {
          throw new Error("Codex active turn identity changed");
        }
        this.nativeTurnId = turnId;
      }
      return;
    }
    if (method === "item/agentMessage/delta" && this.matchesTurn(params)) {
      this.events.text(this.harnessTurnId, params.delta);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && this.matchesTurn(params)) {
      const activity = codexActivity(params.item, method === "item/started" ? "running" : "completed");
      if (activity) this.events.event({
        type: "activity",
        data: { ...activity, turnId: this.harnessTurnId },
      });
      return;
    }
    if (method === "turn/completed" && this.matchesTurn({ ...params, turnId: params.turn?.id })) {
      const harnessTurnId = this.harnessTurnId;
      const status = codexTurnStatus(params.turn?.status);
      this.events.flush(harnessTurnId);
      this.harnessTurnId = undefined;
      this.nativeTurnId = undefined;
      this.cancelRequests();
      this.transition({ type: "complete_turn", turnId: harnessTurnId, status });
    }
  }

  nativeRequest(method, params) {
    if (!this.matchesTurn(params, true)) throw new Error("Codex request targets a stale turn");
    const approvalKind = APPROVAL_METHODS.get(method);
    if (approvalKind) {
      const decisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter((value) => bounded(value))
        : ["accept", "decline", "cancel"];
      if (decisions.length === 0) throw new Error("Codex approval has no supported decision");
      return this.waitForResponse({
        kind: approvalKind,
        title: approvalKind === "command" ? "Approve command" : "Approve file change",
        detail: bounded(params.command ?? params.reason),
        choices: decisions.map((decision) => ({ choiceId: decision, label: decision })),
      });
    }
    if (method === "item/tool/requestUserInput") {
      const properties = {};
      const required = [];
      for (const question of Array.isArray(params.questions) ? params.questions.slice(0, 20) : []) {
        if (!question || typeof question !== "object" || !validPublicId(question.id)) continue;
        const options = Array.isArray(question.options)
          ? question.options
              .filter((option) => option && typeof option === "object")
              .map(({ label }) => bounded(label))
              .filter(Boolean)
              .slice(0, 50)
          : undefined;
        properties[question.id] = {
          type: "string",
          title: bounded(question.header) ?? question.id,
          description: bounded(question.question),
          ...(options ? { enum: options } : {}),
        };
        required.push(question.id);
      }
      if (required.length === 0) throw new Error("Codex input request has no supported question");
      return this.waitForResponse({
        kind: "input",
        title: "Input required",
        inputSchema: { type: "object", properties, required },
      });
    }
    if (method === "item/permissions/requestApproval") {
      if (!params.permissions || typeof params.permissions !== "object" ||
          Array.isArray(params.permissions)) {
        throw new Error("Codex permission request is invalid");
      }
      return this.waitForResponse({
        kind: "permissions",
        title: "Approve additional permissions",
        detail: bounded(params.reason),
        permissions: structuredClone(params.permissions),
        choices: [
          { choiceId: "deny", label: "Deny" },
          { choiceId: "allow-turn", label: "Allow for this turn" },
          { choiceId: "allow-session", label: "Allow for this Session" },
        ],
      });
    }
    throw new Error("Unsupported Codex server request");
  }

  waitForResponse(request) {
    const requestId = `request-${this.nextRequestId++}`;
    const { permissions, ...publicRequest } = request;
    return new Promise((resolve) => {
      this.requests.set(requestId, {
        kind: request.kind,
        choices: new Set(request.choices?.map(({ choiceId }) => choiceId)),
        permissions,
        resolve,
      });
      this.transition({
        type: "wait_for_user",
        turnId: this.harnessTurnId,
        request: { requestId, state: "open", ...publicRequest },
      });
    });
  }

  cancelRequests() {
    for (const request of this.requests.values()) {
      if (request.kind === "input") request.resolve({ answers: {} });
      else if (request.kind === "permissions") request.resolve({ permissions: {} });
      else request.resolve({ decision: "cancel" });
    }
    this.requests.clear();
  }

  matchesTurn(params, allowMissingTurnId = false) {
    return Boolean(this.harnessTurnId) && params.threadId === this.threadId &&
      (!this.nativeTurnId || (allowMissingTurnId && params.turnId == null) ||
        params.turnId === this.nativeTurnId);
  }

  requireActive(turnId) {
    if (!this.harnessTurnId || this.harnessTurnId !== turnId || !this.nativeTurnId) {
      throw new Error("Codex active turn mismatch");
    }
  }

  failed() {
    if (this.terminated) return;
    this.terminated = true;
    this.events.close();
    this.emit({
      type: "error",
      data: { scope: "driver", code: "driver_ended", message: "The Codex driver ended." },
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

function createCodexProcess(options) {
  return new JsonRpcProcess({
    command: "codex",
    args: ["--sandbox", "danger-full-access", "--ask-for-approval", "never", "app-server"],
    ...options,
  });
}

function codexTurnStatus(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function codexActivity(item, status) {
  if (!item || typeof item !== "object") return undefined;
  if (item.type === "commandExecution") {
    return { label: "Command", command: bounded(item.command), status };
  }
  if (item.type === "fileChange") {
    return { label: "File change", target: bounded(item.changes?.[0]?.path), status };
  }
  return undefined;
}

function validNativeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validPublicId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

module.exports = { CodexDriver, createCodexProcess };
