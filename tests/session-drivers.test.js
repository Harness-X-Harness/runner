import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

import { MAX_ACTIVE_SESSIONS } from "../apps/chatgpt-app/src/session-state.js";

const require = createRequire(import.meta.url);
const { CodexDriver, createCodexProcess } = require("../.github/actions/session-runtime/codex-driver.js");
const {
  DriverRegistry,
  MAX_DRIVERS,
} = require("../.github/actions/session-runtime/drivers.js");
const { GrokDriver, createGrokProcess } = require("../.github/actions/session-runtime/grok-driver.js");
const { JsonRpcError, JsonRpcProcess } = require("../.github/actions/session-runtime/json-rpc.js");

test("Codex and Grok native children bypass approvals", () => {
  const spawned = [];
  const spawnProcess = (command, args) => {
    spawned.push({ command, args });
    return fakeChild();
  };
  const codex = createCodexProcess({ spawnProcess });
  const grok = createGrokProcess({ spawnProcess });
  assert.deepEqual(spawned, [
    {
      command: "codex",
      args: ["--sandbox", "danger-full-access", "--ask-for-approval", "never", "app-server"],
    },
    {
      command: "grok",
      args: ["--always-approve", "agent", "--no-leader", "stdio"],
    },
  ]);
  codex.stop();
  grok.stop();
});

test("Codex uses one app-server thread for start, later turns, steer, and exact interrupt", async () => {
  const harness = driverHarness();
  const protocol = new CodexProtocolFixture();
  const driver = new CodexDriver({
    sessionId: "session-1",
    workingDirectory: "/workspace",
    ...harness,
    createProcess: (options) => protocol.connect(options),
  });

  await driver.start({ initial: true, turnId: "turn-1", text: "private prompt one" });
  assert.deepEqual(protocol.methods(), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.deepEqual(harness.transitions.slice(0, 2), [
    { type: "admit" },
    { type: "begin_turn", turnId: "turn-1" },
  ]);

  protocol.pushNotification("item/agentMessage/delta", {
    threadId: "native-thread", turnId: "native-turn-1", itemId: "message-1", delta: "Hello ",
  });
  protocol.pushNotification("item/reasoning/summaryTextDelta", {
    threadId: "native-thread", turnId: "native-turn-1", delta: "private reasoning",
  });
  protocol.pushNotification("item/agentMessage/delta", {
    threadId: "native-thread", turnId: "native-turn-1", itemId: "message-1", delta: "world",
  });
  protocol.pushNotification("turn/completed", {
    threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" },
  });
  assert.deepEqual(harness.events, [{
    type: "agent_message_chunk",
    data: { turnId: "turn-1", text: "Hello world" },
  }]);
  assert.doesNotMatch(JSON.stringify(harness), /private reasoning|private prompt one/);

  protocol.pushNotification("turn/started", {
    threadId: "native-thread", turn: { id: "late-native-turn" },
  });
  protocol.nextTurnId = "native-turn-2";
  await driver.execute(command("start", { turnId: "turn-2", text: "private prompt two" }));
  await driver.execute(command("steer", { turnId: "turn-2", text: "private steer" }));
  await driver.execute(command("interrupt", { turnId: "turn-2" }));
  assert.deepEqual(protocol.methods().slice(-3), ["turn/start", "turn/steer", "turn/interrupt"]);
  assert.deepEqual(protocol.requests.at(-2).params, {
    threadId: "native-thread",
    expectedTurnId: "native-turn-2",
    clientUserMessageId: "turn-2:steer",
    input: [{ type: "text", text: "private steer" }],
  });
  assert.deepEqual(protocol.requests.at(-1).params, {
    threadId: "native-thread", turnId: "native-turn-2",
  });
  protocol.pushNotification("turn/completed", {
    threadId: "native-thread", turn: { id: "native-turn-2", status: "future-status" },
  });
  assert.deepEqual(harness.transitions.at(-1), {
    type: "complete_turn", turnId: "turn-2", status: "failed",
  });

  await driver.execute(command("stop"));
  await immediate();
  assert.equal(protocol.stopped, true);
  assert.deepEqual(harness.transitions.at(-1), { type: "terminate", reason: "stopped" });
});

test("Codex converts approvals and user input to exact bounded Session requests", async () => {
  const harness = driverHarness();
  const protocol = new CodexProtocolFixture();
  const driver = new CodexDriver({
    sessionId: "session-1",
    workingDirectory: "/workspace",
    ...harness,
    createProcess: (options) => protocol.connect(options),
  });
  await driver.start({ initial: true, turnId: "turn-1", text: "prompt" });

  const approval = protocol.requestFromServer("item/commandExecution/requestApproval", {
    threadId: "native-thread",
    turnId: null,
    itemId: "item-1",
    startedAtMs: 1,
    command: "npm test",
    availableDecisions: ["accept", "decline"],
  });
  assert.equal(harness.transitions.at(-1).type, "wait_for_user");
  assert.deepEqual(harness.transitions.at(-1).request.choices, [
    { choiceId: "accept", label: "accept" },
    { choiceId: "decline", label: "decline" },
  ]);
  await driver.execute(command("response", { requestId: "request-1", choiceId: "accept" }));
  assert.deepEqual(await approval, { decision: "accept" });

  const input = protocol.requestFromServer("item/tool/requestUserInput", {
    threadId: "native-thread",
    turnId: "native-turn-1",
    itemId: "item-2",
    isBlocking: true,
    questions: [{ id: "branch", header: "Branch", question: "Which branch?" }],
  });
  await driver.execute(command("response", {
    requestId: "request-2",
    answers: { branch: ["main"] },
  }));
  assert.deepEqual(await input, { answers: { branch: ["main"] } });

  const permissions = { network: { enabled: true } };
  const permission = protocol.requestFromServer("item/permissions/requestApproval", {
    threadId: "native-thread",
    turnId: "native-turn-1",
    itemId: "item-3",
    reason: "Reach the package registry",
    permissions,
  });
  assert.equal(harness.transitions.at(-1).request.kind, "permissions");
  assert.doesNotMatch(JSON.stringify(harness.transitions.at(-1)), /enabled/);
  await driver.execute(command("response", {
    requestId: "request-3",
    choiceId: "allow-turn",
  }));
  assert.deepEqual(await permission, { permissions, scope: "turn" });

  assert.throws(() => protocol.requestFromServer("item/commandExecution/requestApproval", {
    threadId: "native-thread",
    turnId: "native-turn-1",
    availableDecisions: [],
  }), /no supported decision/);
});

test("Codex fails closed on protocol drift and reports a failed turn without a fallback", async () => {
  const harness = driverHarness();
  const missing = new CodexProtocolFixture({ userAgent: "" });
  const driver = new CodexDriver({
    sessionId: "session-1",
    workingDirectory: "/workspace",
    ...harness,
    createProcess: (options) => missing.connect(options),
  });
  await assert.rejects(() => driver.start({ initial: true }), /contract is unavailable/);

  const workingHarness = driverHarness();
  const failing = new CodexProtocolFixture({ failTurn: true });
  const working = new CodexDriver({
    sessionId: "session-2",
    workingDirectory: "/workspace",
    ...workingHarness,
    createProcess: (options) => failing.connect(options),
  });
  await working.start({ initial: true });
  await working.execute(command("start", { turnId: "turn-1", text: "prompt" }));
  assert.equal(workingHarness.events.at(-1).data.code, "turn_failed");
  assert.deepEqual(workingHarness.transitions.at(-1), {
    type: "complete_turn", turnId: "turn-1", status: "failed",
  });
  assert.equal(failing.methods().includes("codex exec"), false);
});

test("Grok uses ACP for repeated prompts, interject, interrupt, streaming, and stop", async () => {
  const harness = driverHarness();
  const protocol = new GrokProtocolFixture();
  const driver = new GrokDriver({
    sessionId: "session-1",
    workingDirectory: "/workspace",
    ...harness,
    createProcess: (options) => protocol.connect(options),
  });
  await driver.start({ initial: true, turnId: "turn-1", text: "private prompt one" });
  assert.deepEqual(protocol.methods().slice(0, 4), [
    "initialize", "_x.ai/interject", "session/new", "session/prompt",
  ]);
  assert.deepEqual(harness.transitions.slice(0, 2), [
    { type: "admit" },
    { type: "begin_turn", turnId: "turn-1" },
  ]);

  protocol.pushNotification("session/update", {
    sessionId: "native-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
  });
  protocol.pushNotification("session/update", {
    sessionId: "native-session",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } },
  });
  protocol.pushNotification("session/update", {
    sessionId: "native-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
  });
  protocol.finishPrompt({ stopReason: "end_turn" });
  await immediate();
  assert.deepEqual(harness.events, [{
    type: "agent_message_chunk",
    data: { turnId: "turn-1", text: "Hello world" },
  }]);
  assert.doesNotMatch(JSON.stringify(harness), /private thought|private prompt one/);

  driver.execute(command("start", { turnId: "turn-2", text: "private prompt two" }));
  await driver.execute(command("steer", { turnId: "turn-2", text: "private steer" }));
  await driver.execute(command("interrupt", { turnId: "turn-2" }));
  assert.deepEqual(protocol.methods().slice(-3), ["session/prompt", "_x.ai/interject", "session/cancel"]);
  assert.equal(protocol.requests.at(-2).params.text, "private steer");
  protocol.finishPrompt({ stopReason: "max_tokens" });
  await immediate();
  assert.deepEqual(harness.transitions.at(-1), {
    type: "complete_turn", turnId: "turn-2", status: "failed",
  });

  await driver.execute(command("stop"));
  await immediate();
  assert.equal(protocol.stopped, true);
  assert.deepEqual(harness.transitions.at(-1), { type: "terminate", reason: "stopped" });
});

test("Grok maps exact ACP permissions and fails closed when interject is absent", async () => {
  const harness = driverHarness();
  const protocol = new GrokProtocolFixture();
  const driver = new GrokDriver({
    sessionId: "session-1",
    workingDirectory: "/workspace",
    ...harness,
    createProcess: (options) => protocol.connect(options),
  });
  await driver.start({ initial: true, turnId: "turn-1", text: "prompt" });
  const permission = protocol.requestFromServer("session/request_permission", {
    sessionId: "native-session",
    toolCall: { title: "Run command", kind: "execute" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  await driver.execute(command("response", {
    requestId: "request-1",
    choiceId: "allow-once",
  }));
  assert.deepEqual(await permission, {
    outcome: { outcome: "selected", optionId: "allow-once" },
  });

  const missing = new GrokProtocolFixture({ missingInterject: true });
  const missingDriver = new GrokDriver({
    sessionId: "session-2",
    workingDirectory: "/workspace",
    ...driverHarness(),
    createProcess: (options) => missing.connect(options),
  });
  await assert.rejects(() => missingDriver.start({ initial: true }), /capability is unavailable/);
  assert.equal(missing.methods().includes("session/new"), false);

  assert.throws(() => protocol.requestFromServer("session/request_permission", {
    sessionId: "native-session",
    options: [{ optionId: "allow-once", name: "" }],
  }), /no supported choice/);

  const failedHarness = driverHarness();
  const failedProtocol = new GrokProtocolFixture();
  const failedDriver = new GrokDriver({
    sessionId: "session-3",
    workingDirectory: "/workspace",
    ...failedHarness,
    createProcess: (options) => failedProtocol.connect(options),
  });
  await failedDriver.start({ initial: true, turnId: "turn-failed", text: "private prompt" });
  failedProtocol.failPrompt();
  await immediate();
  assert.equal(failedHarness.events.at(-1).data.code, "turn_failed");
  assert.doesNotMatch(JSON.stringify(failedHarness), /private prompt|native failure/);
  assert.deepEqual(failedHarness.transitions.at(-1), {
    type: "complete_turn", turnId: "turn-failed", status: "failed",
  });
});

test("JSON-RPC fails closed when a request or server response cannot be written", async () => {
  const requestChild = fakeChild();
  const requestRpc = new JsonRpcProcess({
    command: "native",
    args: [],
    spawnProcess: () => requestChild,
  });
  requestChild.stdin.destroy();
  await assert.rejects(() => requestRpc.request("method", {}), /unavailable/);
  assert.equal(requestRpc.pending.size, 0);

  const responseChild = fakeChild();
  const responseRpc = new JsonRpcProcess({
    command: "native",
    args: [],
    onRequest: () => ({ ok: true }),
    spawnProcess: () => responseChild,
  });
  responseChild.stdin.destroy();
  responseChild.stdout.write('{"jsonrpc":"2.0","id":1,"method":"client/request","params":{}}\n');
  await immediate();
  assert.equal(responseChild.signal, "SIGTERM");
  responseRpc.stop();

  const rejectedChild = fakeChild();
  let rejectedResponse = "";
  rejectedChild.stdin.on("data", (chunk) => {
    rejectedResponse += chunk;
  });
  const rejectedRpc = new JsonRpcProcess({
    command: "native",
    args: [],
    onRequest: () => { throw new Error("private request failure"); },
    spawnProcess: () => rejectedChild,
  });
  rejectedChild.stdout.write('{"jsonrpc":"2.0","id":2,"method":"client/request","params":{}}\n');
  await immediate();
  assert.deepEqual(JSON.parse(rejectedResponse), {
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32603, message: "Session request failed" },
  });
  assert.doesNotMatch(rejectedResponse, /private request failure/);
  rejectedRpc.stop();
});

test("registry isolates one child per Session and bounds startup failure", async () => {
  const events = [];
  const transitions = [];
  class FailingDriver {
    async start() { throw new Error("private endpoint and prompt"); }
    stop() { this.stopped = true; }
  }
  const registry = new DriverRegistry({
    emit: (sessionId, event) => events.push({ sessionId, event }),
    transition: (sessionId, action) => transitions.push({ sessionId, action }),
    driverTypes: { codex: FailingDriver },
  });
  await registry.execute("session-1", {
    executor: "codex",
    workingDirectory: "/workspace",
    kind: "start",
    payload: { initial: true },
  });
  assert.equal(events[0].event.data.code, "startup_failed");
  assert.doesNotMatch(JSON.stringify(events), /private endpoint|prompt/);
  assert.deepEqual(transitions, [{
    sessionId: "session-1",
    action: { type: "terminate", reason: "driver_failed" },
  }]);

  class CommandFailingDriver {
    async start() {}
    async execute() { throw new Error("private command failure"); }
    stop() { this.terminated = true; }
  }
  const commandEvents = [];
  const commandTransitions = [];
  const commandRegistry = new DriverRegistry({
    emit: (sessionId, event) => commandEvents.push({ sessionId, event }),
    transition: (sessionId, action) => commandTransitions.push({ sessionId, action }),
    driverTypes: { grok: CommandFailingDriver },
  });
  await commandRegistry.execute("session-2", {
    executor: "grok", workingDirectory: "/workspace", kind: "start", payload: { initial: true },
  });
  await commandRegistry.execute("session-2", command("steer", {
    turnId: "turn-1", text: "private command",
  }));
  assert.equal(commandEvents[0].event.data.code, "command_failed");
  assert.doesNotMatch(JSON.stringify(commandEvents), /private command/);
  assert.deepEqual(commandTransitions, [{
    sessionId: "session-2",
    action: { type: "terminate", reason: "driver_failed" },
  }]);
});

test("registry capacity rejects only the new Session driver", async () => {
  assert.equal(MAX_DRIVERS, MAX_ACTIVE_SESSIONS);
  const events = [];
  const transitions = [];
  const drivers = [];
  class Driver {
    constructor({ sessionId }) {
      this.sessionId = sessionId;
      drivers.push(this);
    }
    async start() {}
    stop() { this.stopped = true; }
  }
  const registry = new DriverRegistry({
    emit: (sessionId, event) => events.push({ sessionId, event }),
    transition: (sessionId, action) => transitions.push({ sessionId, action }),
    driverTypes: { codex: Driver },
    maxDrivers: 1,
  });
  const start = (sessionId) => registry.execute(sessionId, {
    executor: "codex",
    workingDirectory: "/workspace",
    kind: "start",
    payload: { initial: true },
  });
  await start("session-a");
  await start("session-b");

  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].stopped, undefined);
  assert.deepEqual(events, []);
  assert.deepEqual(transitions, [{
    sessionId: "session-b",
    action: { type: "terminate", reason: "resource_exhausted" },
  }]);
});

class CodexProtocolFixture {
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

  stop() {
    this.stopped = true;
  }
}

class GrokProtocolFixture {
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

  stop() {
    this.stopped = true;
    for (const { reject } of this.promptResolvers) reject(new Error("fixture stopped"));
    this.promptResolvers = [];
  }
}

function driverHarness() {
  const events = [];
  const transitions = [];
  return {
    events,
    transitions,
    emit: (event) => events.push(event),
    transition: (action) => transitions.push(action),
  };
}

function command(kind, payload) {
  return { commandId: `command-${kind}`, kind, payload };
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = (signal) => {
    child.signal = signal;
  };
  return child;
}
