const { TaskError } = require("../../../shared/task-errors.js");
const { JsonRpcProcess } = require("./json-rpc.js");

class CodexClient {
  constructor({ workingDirectory, onNotification, onRequest, onExit, createProcess = createCodexProcess, env }) {
    this.workingDirectory = workingDirectory;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.createProcess = createProcess;
    this.env = env;
  }

  async initialize() {
    this.rpc = this.createProcess({
      cwd: this.workingDirectory,
      env: this.env,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => {
        if (!this.matches(params, true)) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
        return this.onRequest(method, params);
      },
      onExit: (error) => this.onExit?.(error),
    });
    const initialized = await this.rpc.request("initialize", {
      clientInfo: { name: "harness-runner", title: "Harness Runner", version: "1.0.0" },
      capabilities: {},
    });
    if (typeof initialized.userAgent !== "string" || !initialized.userAgent) {
      throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    }
    this.rpc.notify("initialized", {});
    const started = await this.rpc.request("thread/start", {
      cwd: this.workingDirectory, approvalPolicy: "never", sandbox: "danger-full-access",
    });
    this.threadId = started.thread?.id;
    if (!validNativeId(this.threadId)) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
  }

  async startTurn(text, messageId) {
    if (this.turn) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    const turn = this.turn = {};
    try {
      const result = await this.rpc.request("turn/start", {
        threadId: this.threadId,
        clientUserMessageId: messageId,
        input: [{ type: "text", text }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      if (!validNativeId(result?.turn?.id)) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      if (this.turn === turn) this.bindTurn(result.turn.id);
    } catch (error) {
      if (this.turn === turn) this.turn = undefined;
      throw error;
    }
  }

  async steer(text, messageId) {
    const turnId = this.activeTurnId();
    const result = await this.rpc.request("turn/steer", {
      threadId: this.threadId, expectedTurnId: turnId,
      clientUserMessageId: messageId, input: [{ type: "text", text }],
    });
    if (result.turnId !== turnId) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
  }

  interrupt() {
    return this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId() });
  }

  activeTurnId() {
    if (!this.turn?.id) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    return this.turn.id;
  }

  bindTurn(id) {
    if (this.turn.id && this.turn.id !== id) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    this.turn.id = id;
  }

  matches(params, allowMissingTurnId = false) {
    return Boolean(this.turn) && params.threadId === this.threadId &&
      ((allowMissingTurnId && params.turnId == null) ||
        (Boolean(this.turn.id) && params.turnId === this.turn.id));
  }

  notification(method, params) {
    if (method === "turn/started" && this.turn && params.threadId === this.threadId) {
      if (validNativeId(params.turn?.id)) this.bindTurn(params.turn.id);
      return;
    }
    if (!this.matches(method === "turn/completed" ? { ...params, turnId: params.turn?.id } : params)) return;
    if (method === "turn/completed") this.turn = undefined;
    this.onNotification?.(method, params);
  }

  stop() { return this.rpc?.stop(); }
  close() { return this.rpc?.close(); }
}

function createCodexProcess(options) {
  return new JsonRpcProcess({
    command: "codex",
    args: ["--sandbox", "danger-full-access", "--ask-for-approval", "never", "app-server"],
    ...options,
    // Codex App Server omits the JSON-RPC version field on the wire.
    omitVersion: true,
  });
}

function validNativeId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

module.exports = { CodexClient, createCodexProcess };
