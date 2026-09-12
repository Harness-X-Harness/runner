const { randomUUID } = require("node:crypto");
const { CodexClient } = require("./codex-client.js");
const { GrokClient } = require("./grok-client.js");
const { codexApproval, grokApproval } = require("./approvals.js");
const { JsonRpcError } = require("./json-rpc.js");
const { TaskError } = require("../../../shared/task-errors.js");

class AgentRuntime {
  constructor(executor, { createProcess, env, cleanupMs = 1500 } = {}) {
    if (!["codex", "grok"].includes(executor)) throw new TaskError("PROVIDER_UNAVAILABLE");
    this.executor = executor;
    this.createProcess = createProcess;
    this.env = env;
    this.cleanupMs = cleanupMs;
  }

  async run({ prompt, workingDirectory }) {
    if (this.started || this.closed || typeof prompt !== "string" || !prompt.trim() ||
        typeof workingDirectory !== "string" || !workingDirectory) {
      throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    }
    this.started = true;
    this.currentText = "";
    this.finalResponse = undefined;
    const failure = new Promise((_, reject) => { this.reject = reject; });
    const completed = new Promise((resolve) => { this.complete = resolve; });
    const Client = this.executor === "codex" ? CodexClient : GrokClient;
    this.client = new Client({
      workingDirectory, createProcess: this.createProcess, env: this.env,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.request(method, params),
      onExit: (error) => this.reject(safeFailure(error)),
    });
    const execute = async () => {
      try {
        await this.client.initialize();
      } catch (error) {
        throw safeFailure(error, "PROVIDER_PROTOCOL_ERROR");
      }
      const result = await this.client.startTurn(prompt, randomUUID());
      if (this.executor === "grok") {
        if (!["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(result?.stopReason)) {
          throw new TaskError("PROVIDER_PROTOCOL_ERROR");
        }
        if (result.stopReason !== "end_turn") throw new TaskError("PROVIDER_EXECUTION_ERROR");
        // Grok's response_completed extension closes each model response, not the whole prompt.
        if (!this.responseCompleted || this.currentText ||
            (this.responseStopReason != null && !["end_turn", "stop", "completed"].includes(this.responseStopReason))) {
          throw new TaskError("PROVIDER_PROTOCOL_ERROR");
        }
      } else {
        await completed;
      }
      if (typeof this.finalResponse !== "string" || !this.finalResponse.trim()) {
        throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      }
      return { finalResponse: this.finalResponse };
    };
    try {
      return await Promise.race([execute(), failure]);
    } catch (error) {
      throw safeFailure(error);
    } finally {
      this.done = true;
      await this.close();
      this.currentText = undefined;
      this.finalResponse = undefined;
    }
  }

  notification(method, params) {
    try {
      if (this.executor === "codex") this.codexNotification(method, params);
      else this.grokNotification(params.update);
    } catch (error) {
      this.reject(safeFailure(error, "PROVIDER_PROTOCOL_ERROR"));
    }
  }

  codexNotification(method, params) {
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const { text, phase } = params.item;
      if (typeof text !== "string" || ![undefined, null, "commentary", "final_answer"].includes(phase)) {
        throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      }
      this.finalResponse = phase === "commentary" ? undefined : text;
    } else if (method === "item/started" &&
        ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(params.item?.type)) {
      this.finalResponse = undefined;
    } else if (method === "turn/completed") {
      const status = params.turn?.status;
      if (!["completed", "failed", "interrupted"].includes(status)) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      if (status !== "completed") throw new TaskError("PROVIDER_EXECUTION_ERROR");
      this.complete();
    }
  }

  grokNotification(update) {
    if (!update || typeof update !== "object") throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content?.type !== "text" || typeof update.content.text !== "string") {
        throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      }
      this.currentText += update.content.text;
      this.responseCompleted = false;
    } else if (update.sessionUpdate === "response_completed") {
      this.finalResponse = this.currentText;
      this.responseStopReason = update.stop_reason;
      this.currentText = "";
      this.responseCompleted = true;
    } else if (update.sessionUpdate === "response_started") {
      // A second response cannot silently replace an unclosed response.
      if (this.currentText) throw new TaskError("PROVIDER_PROTOCOL_ERROR");
      this.responseCompleted = false;
    }
  }

  request(method, params) {
    try {
      if (this.executor === "codex") {
        const approval = codexApproval(method, params);
        if (approval) return approval;
        if (["item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(method)) {
          throw new TaskError("USER_INPUT_REQUIRED");
        }
      } else {
        if (method === "session/request_permission") return grokApproval(params);
        if (["_x.ai/ask_user_question", "_x.ai/mcp/elicit"].includes(method)) {
          throw new TaskError("USER_INPUT_REQUIRED");
        }
        if (method === "_x.ai/exit_plan_mode") return { outcome: "approved", feedback: null };
      }
      throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    } catch (error) {
      const failure = safeFailure(error, "PROVIDER_PROTOCOL_ERROR");
      this.reject(failure);
      throw failure;
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    if (!this.done) this.reject?.(new TaskError("PROVIDER_EXECUTION_ERROR"));
    this.closing = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.client?.close()),
          new Promise((resolve) => { timer = setTimeout(resolve, this.cleanupMs); }),
        ]);
      } catch {
        // Cleanup never replaces the primary result or failure.
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.closing;
  }
}

function safeFailure(error, otherwise = "PROVIDER_EXECUTION_ERROR") {
  if (error instanceof TaskError) return error;
  if (error instanceof JsonRpcError && [-32700, -32600, -32601, -32602].includes(error.code)) {
    return new TaskError("PROVIDER_PROTOCOL_ERROR");
  }
  return new TaskError(otherwise);
}

module.exports = { AgentRuntime };
