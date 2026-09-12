import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JsonRpcError } = require("../../.github/actions/agent-runtime/json-rpc.js");

export class CodexProtocolFixture {
  constructor({ userAgent = "codex-test", failTurn = false } = {}) {
    this.userAgent = userAgent;
    this.failTurn = failTurn;
    this.nextTurnId = "native-turn-1";
    this.requests = [];
  }

  connect(options) {
    this.options = options;
    return this;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: this.userAgent };
    if (method === "thread/start") return { thread: { id: "native-thread" } };
    if (method === "turn/start") {
      if (this.failTurn) throw new JsonRpcError(-32601);
      return { turn: { id: this.nextTurnId } };
    }
    if (method === "turn/steer") return { turnId: this.nextTurnId };
    return {};
  }

  notify(method, params) {
    this.requests.push({ method, params });
  }

  pushNotification(method, params) {
    this.options.onNotification(method, params);
  }

  requestFromServer(method, params) {
    return this.options.onRequest(method, params, 100);
  }

  methods() {
    return this.requests.map(({ method }) => method);
  }

  async close() { this.stop(); }

  stop() {
    this.stopped = true;
  }
}

export class GrokProtocolFixture {
  constructor({ missingInterject = false } = {}) {
    this.missingInterject = missingInterject;
    this.requests = [];
    this.promptResolvers = [];
  }

  connect(options) {
    this.options = options;
    return this;
  }

  request(method, params) {
    this.requests.push({ method, params });
    if (method === "initialize") return Promise.resolve({ protocolVersion: 1 });
    if (method === "_x.ai/interject" && !params.sessionId) {
      return Promise.reject(new JsonRpcError(this.missingInterject ? -32601 : -32602));
    }
    if (method === "session/new") return Promise.resolve({ sessionId: "native-session" });
    if (method === "session/prompt") {
      return new Promise((resolve, reject) => this.promptResolvers.push({ resolve, reject }));
    }
    if (method === "_x.ai/interject") return Promise.resolve({ status: "queued" });
    return Promise.resolve({});
  }

  notify(method, params) {
    this.requests.push({ method, params });
  }

  pushNotification(method, params) {
    this.options.onNotification(method, params);
  }

  requestFromServer(method, params) {
    return this.options.onRequest(method, params, 100);
  }

  finishPrompt(result) {
    this.promptResolvers.shift().resolve(result);
  }

  failPrompt() {
    this.promptResolvers.shift().reject(new Error("private native failure"));
  }

  methods() {
    return this.requests.map(({ method }) => method);
  }

  async close() { this.stop(); }

  stop() {
    this.stopped = true;
    for (const { reject } of this.promptResolvers) reject(new Error("fixture stopped"));
    this.promptResolvers = [];
  }
}
