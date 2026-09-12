import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexProtocolFixture, GrokProtocolFixture } from "./helpers/native-protocol.js";

const require = createRequire(import.meta.url);
const { CodexClient, createCodexProcess } = require("../.github/actions/agent-runtime/codex-client.js");
const { GrokClient } = require("../.github/actions/agent-runtime/grok-client.js");
const { JsonRpcProcess } = require("../.github/actions/agent-runtime/json-rpc.js");

test("native clients initialize and route only their own active protocol conversation", async () => {
  for (const [Client, Fixture] of [[CodexClient, CodexProtocolFixture], [GrokClient, GrokProtocolFixture]]) {
    const protocol = new Fixture();
    const notifications = [], requests = [];
    const client = new Client({
      workingDirectory: "/workspace",
      createProcess: (options) => protocol.connect(options),
      onNotification: (...args) => notifications.push(args),
      onRequest: (...args) => { requests.push(args); return { allowed: true }; },
    });
    await client.initialize();
    const turn = client.startTurn("private prompt", "message-1");
    await new Promise((resolve) => setImmediate(resolve));
    const method = Client === CodexClient ? "item/agentMessage/delta" : "session/update";
    const params = Client === CodexClient ? { threadId: "native-thread", turnId: "native-turn-1" } : { sessionId: "native-session" };
    protocol.pushNotification(method, { ...params, threadId: "foreign", sessionId: "foreign" });
    assert.equal(notifications.length, 0);
    protocol.pushNotification(method, params);
    assert.equal(notifications.length, 1);
    assert.deepEqual(protocol.requestFromServer("native/request", params), { allowed: true });
    assert.equal(requests.length, 1);
    assert.throws(() => protocol.requestFromServer("native/request", { threadId: "foreign", sessionId: "foreign" }), { code: "PROVIDER_PROTOCOL_ERROR" });
    if (Client === GrokClient) protocol.finishPrompt({ stopReason: "end_turn" });
    await turn;
    await client.close();
    assert.equal(protocol.stopped, true);
  }
});

test("Codex ignores unbound output and allows native completion before turn/start returns", async () => {
  const protocol = new CodexProtocolFixture();
  const request = protocol.request.bind(protocol);
  let reply;
  protocol.request = (method, params) => method === "turn/start"
    ? new Promise((resolve) => { reply = resolve; }) : request(method, params);
  const events = [];
  const client = new CodexClient({
    workingDirectory: "/workspace", createProcess: (options) => protocol.connect(options),
    onNotification: (method) => events.push(method),
  });
  await client.initialize();
  const started = client.startTurn("private", "message");
  protocol.pushNotification("item/completed", { threadId: "native-thread", turnId: "foreign" });
  assert.deepEqual(events, []);
  protocol.pushNotification("turn/started", { threadId: "native-thread", turn: { id: "native-turn" } });
  protocol.pushNotification("item/completed", { threadId: "native-thread", turnId: "native-turn" });
  protocol.pushNotification("turn/completed", { threadId: "native-thread", turn: { id: "native-turn", status: "completed" } });
  reply({ turn: { id: "native-turn" } });
  await started;
  assert.deepEqual(events, ["item/completed", "turn/completed"]);
  assert.equal(client.turn, undefined);
  await client.close();
});

test("native client initialization rejects unsupported versions and malformed identities", async () => {
  for (const [Client, Fixture, badMethod, value] of [
    [CodexClient, CodexProtocolFixture, "initialize", {}],
    [CodexClient, CodexProtocolFixture, "thread/start", { thread: { id: "" } }],
    [GrokClient, GrokProtocolFixture, "initialize", { protocolVersion: 999 }],
    [GrokClient, GrokProtocolFixture, "session/new", { sessionId: 42 }],
  ]) {
    const protocol = new Fixture();
    const request = protocol.request.bind(protocol);
    protocol.request = (method, params) => method === badMethod ? Promise.resolve(value) : request(method, params);
    const client = new Client({ workingDirectory: "/workspace", createProcess: (options) => protocol.connect(options) });
    await assert.rejects(() => client.initialize(), { code: "PROVIDER_PROTOCOL_ERROR" });
    await client.close();
  }
});

function child() {
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.signals = [];
  process.kill = (signal) => { process.signals.push(signal); return true; };
  return process;
}

test("Codex uses its native headerless envelope through the real process transport", async (t) => {
  const process = child(), sent = [], events = [];
  process.kill = () => { process.emit("exit"); return true; };
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  process.stdin.on("data", (line) => {
    const message = JSON.parse(line);
    sent.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") emit({ id: message.id, result: { userAgent: "codex/0.154.0" } });
      if (message.method === "thread/start") {
        if (message.params.sandbox !== "danger-full-access") emit({ id: message.id, error: { code: -32600, message: "Invalid sandbox mode" } });
        else emit({ id: message.id, result: { thread: { id: "thread-1" } } });
      }
      if (message.method === "turn/start") emit({ id: message.id, result: { turn: { id: "turn-1" } } });
    });
  });
  const client = new CodexClient({ workingDirectory: "/workspace",
    createProcess: (options) => createCodexProcess({ ...options, spawnProcess: () => process }),
    onNotification: (method) => events.push(method), onRequest: () => ({ decision: "accept" }),
  });
  t.after(() => client.close());
  await client.initialize();
  await client.startTurn("private", "message-1");
  emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1" } });
  emit({ id: 90, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["item/completed"]);
  assert.deepEqual(sent.at(-1), { id: 90, result: { decision: "accept" } });
  assert.ok(sent.every((message) => !Object.hasOwn(message, "jsonrpc")));
});

test("native envelope choice does not relax Grok JSON-RPC or accept wrong versions", async () => {
  for (const [create, envelope] of [
    [(options) => new JsonRpcProcess({ command: "grok", args: [], ...options }), {}],
    [createCodexProcess, { jsonrpc: "1.0" }],
  ]) {
    const process = child();
    process.kill = () => { process.emit("exit"); return true; };
    const rpc = create({ spawnProcess: () => process });
    const rejected = assert.rejects(rpc.request("initialize", {}), { code: "PROVIDER_PROTOCOL_ERROR" });
    process.stdout.write(`${JSON.stringify({ ...envelope, id: 1, result: {} })}\n`);
    await rejected;
    await rpc.close();
  }
});

test("JSON-RPC process failures are typed, reject pending operations and report one exit", async () => {
  for (const [event, code] of [["error", "PROVIDER_UNAVAILABLE"], ["exit", "PROVIDER_EXECUTION_ERROR"], ["malformed", "PROVIDER_PROTOCOL_ERROR"]]) {
    const process = child(), exits = [];
    const rpc = new JsonRpcProcess({ command: "fixture", args: [], spawnProcess: () => process, onExit: (error) => exits.push(error.code) });
    const pending = rpc.request("initialize", {});
    const rejected = assert.rejects(pending, { code });
    if (event === "malformed") process.stdout.write("not json\n");
    else process.emit(event, new Error("private native failure"));
    await rejected;
    process.emit("exit");
    assert.deepEqual(exits, [code]);
    assert.equal(rpc.pending.size, 0);
    await rpc.close({ graceMs: 1 });
  }
});

test("JSON-RPC shutdown escalates a stubborn process and remains bounded", async () => {
  const process = child();
  const rpc = new JsonRpcProcess({ command: "fixture", args: [], spawnProcess: () => process });
  const request = rpc.request("unfinished", {});
  const rejected = assert.rejects(request, { code: "PROVIDER_EXECUTION_ERROR" });
  await rpc.close({ graceMs: 5 });
  await rejected;
  assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(process.stdin.destroyed, true);
  assert.equal(process.stdout.destroyed, true);
});
