const { TaskError } = require("../../../shared/task-errors.js");
const { JsonRpcProcess } = require("./json-rpc.js");

class GrokClient {
  constructor({ workingDirectory, onNotification, onRequest, onExit, createProcess = createGrokProcess, env }) {
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
      onNotification: (method, params) => {
        if (["session/update", "_x.ai/session_notification", "_x.ai/session/update"].includes(method) &&
            this.active && params.sessionId === this.sessionId) {
          this.onNotification?.(method, params);
        }
      },
      onRequest: (method, params) => {
        if (!this.active || params.sessionId !== this.sessionId) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
        return this.onRequest(method, params);
      },
      onExit: (error) => this.onExit?.(error),
    });
    const initialized = await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "harness-runner", title: "Harness Runner", version: "1.0.0" },
    });
    if (initialized.protocolVersion !== 1) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    const started = await this.rpc.request("session/new", { cwd: this.workingDirectory, mcpServers: [] });
    this.sessionId = started.sessionId;
    if (typeof this.sessionId !== "string" || !this.sessionId || this.sessionId.length > 512) {
      throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    }
  }

  async startTurn(text) {
    if (this.active) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    this.active = true;
    try {
      return await this.rpc.request("session/prompt", {
        sessionId: this.sessionId, prompt: [{ type: "text", text }],
      });
    } finally {
      this.active = false;
    }
  }

  close() { return this.rpc?.close(); }
}

function createGrokProcess(options) {
  return new JsonRpcProcess({
    command: "grok", args: ["--always-approve", "agent", "--no-leader", "stdio"], ...options,
  });
}

module.exports = { GrokClient, createGrokProcess };
