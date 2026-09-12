const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { TaskError } = require("../../../shared/task-errors.js");

class JsonRpcError extends Error {
  constructor(code) {
    super("Native JSON-RPC request failed");
    this.code = code;
  }
}

class JsonRpcProcess {
  constructor({ command, args, cwd, env, onNotification, onRequest, onExit, spawnProcess = spawn }) {
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.stopping = false;
    this.child = spawnProcess(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.exited = new Promise((resolve) => {
      const done = () => { this.hasExited = true; resolve(); };
      this.child.once("exit", done);
      this.child.once("error", done);
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.child.stdin.on("error", () => this.ended());
    this.child.once("error", () => this.ended(new TaskError("PROVIDER_UNAVAILABLE")));
    this.child.once("exit", () => this.ended());
  }

  request(method, params) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending.reject(error);
    }
    return result;
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.lines.close();
    this.child.kill("SIGTERM");
  }

  async close({ graceMs = 1000 } = {}) {
    this.stop();
    let timer;
    try {
      await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
      if (!this.hasExited) this.child.kill("SIGKILL");
    } finally {
      clearTimeout(timer);
      this.lines.close();
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.ended();
    }
  }

  write(message) {
    if (!this.child.stdin.writable || this.endedOnce) throw new TaskError("PROVIDER_UNAVAILABLE");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.ended(new TaskError("PROVIDER_PROTOCOL_ERROR"));
      this.child.kill("SIGTERM");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      this.ended(new TaskError("PROVIDER_PROTOCOL_ERROR"));
      this.child.kill("SIGTERM");
      return;
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new JsonRpcError(message.error.code));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new TaskError("PROVIDER_PROTOCOL_ERROR"));
      return;
    }
    if (typeof message.method !== "string") return;
    if (!Object.hasOwn(message, "id")) {
      try {
        this.onNotification?.(message.method, message.params ?? {});
      } catch (error) {
        this.ended(error instanceof TaskError ? error : new TaskError("PROVIDER_PROTOCOL_ERROR"));
        this.child.kill("SIGTERM");
      }
      return;
    }
    Promise.resolve().then(
      () => this.onRequest?.(message.method, message.params ?? {}, message.id),
    ).then(
      (result) => this.respond({ jsonrpc: "2.0", id: message.id, result: result ?? {} }),
      () => this.respond({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "Native request failed" },
      }),
    );
  }

  respond(message) {
    try {
      this.write(message);
    } catch {
      if (!this.stopping) this.child.kill("SIGTERM");
    }
  }

  ended(error = new TaskError("PROVIDER_EXECUTION_ERROR")) {
    if (this.endedOnce) return;
    this.endedOnce = true;
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.onExit?.(error);
  }
}

module.exports = { JsonRpcError, JsonRpcProcess };
