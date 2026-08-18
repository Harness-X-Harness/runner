const readline = require("node:readline");
const { spawn } = require("node:child_process");

class JsonRpcError extends Error {
  constructor(code) {
    super("Native JSON-RPC request failed");
    this.code = code;
  }
}

class JsonRpcProcess {
  constructor({ command, args, cwd, onNotification, onRequest, onExit, spawnProcess = spawn }) {
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.stopping = false;
    this.child = spawnProcess(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.child.stdin.on("error", () => this.ended());
    this.child.once("error", () => this.ended());
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

  write(message) {
    if (!this.child.stdin.writable) throw new Error("Native JSON-RPC process is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.child.kill("SIGTERM");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new JsonRpcError(message.error.code));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== "string") return;
    if (!Object.hasOwn(message, "id")) {
      try {
        this.onNotification?.(message.method, message.params ?? {});
      } catch {
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
        error: { code: -32603, message: "Session request failed" },
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

  ended() {
    if (this.endedOnce) return;
    this.endedOnce = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error("Native JSON-RPC process ended"));
    }
    this.pending.clear();
    if (!this.stopping) this.onExit?.();
  }
}

module.exports = { JsonRpcError, JsonRpcProcess };
