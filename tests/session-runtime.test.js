import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { MAX_SESSION_COMMANDS } from "../apps/chatgpt-app/src/session-state.js";

const require = createRequire(import.meta.url);
const {
  ENVIRONMENT_CHANNEL_PROTOCOL,
  MAX_RECEIPTS_PER_SESSION,
  SessionRuntime,
  channelProtocols,
} = require("../.github/actions/session-runtime/index.js");

test("runner protocol carries OIDC only in the WebSocket handshake", () => {
  assert.equal(MAX_RECEIPTS_PER_SESSION, MAX_SESSION_COMMANDS);
  const protocols = channelProtocols("header.payload.signature");
  assert.deepEqual(protocols, [
    ENVIRONMENT_CHANNEL_PROTOCOL,
    "oidc.header.payload.signature",
  ]);
  assert.doesNotMatch(JSON.stringify({ type: "hello" }), /header|payload|signature/);
});

test("lost acknowledgements redeliver without repeating one native effect", async () => {
  const sent = [];
  let effects = 0;
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send: (message) => sent.push(message),
    execute: async () => { effects += 1; },
  });
  const command = {
    type: "command",
    generation: "generation-1",
    sessionId: "session-1",
    command: { commandId: "command-1", kind: "start", payload: { text: "hello" } },
  };

  await runtime.receive(JSON.stringify(command));
  await runtime.receive(JSON.stringify(command));

  assert.equal(effects, 1);
  assert.deepEqual(sent, [
    { type: "ack", generation: "generation-1", sessionId: "session-1", commandId: "command-1" },
    { type: "ack", generation: "generation-1", sessionId: "session-1", commandId: "command-1" },
  ]);
});

test("one runtime multiplexes Sessions and ignores stale-generation commands", async () => {
  const effects = [];
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send() {},
    execute: async (sessionId, command) => effects.push([sessionId, command.commandId]),
  });
  await runtime.receive(JSON.stringify({
    type: "commands",
    generation: "generation-1",
    commands: [
      { sessionId: "session-a", commandId: "command-a", kind: "start", payload: {} },
      { sessionId: "session-b", commandId: "command-b", kind: "start", payload: {} },
    ],
  }));
  await runtime.receive(JSON.stringify({
    type: "command",
    generation: "generation-old",
    sessionId: "session-a",
    command: { commandId: "command-stale", kind: "start", payload: {} },
  }));
  assert.deepEqual(effects, [
    ["session-a", "command-a"],
    ["session-b", "command-b"],
  ]);
});

test("a failed native effect emits one bounded error and is not repeated", async () => {
  const sent = [];
  let effects = 0;
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send: (message) => sent.push(message),
    execute: async () => {
      effects += 1;
      throw new Error("private native failure");
    },
  });
  const command = JSON.stringify({
    type: "command",
    generation: "generation-1",
    sessionId: "session-1",
    command: { commandId: "command-1", kind: "start", payload: {} },
  });
  await runtime.receive(command);
  await runtime.receive(command);

  assert.equal(effects, 1);
  assert.equal(sent.filter(({ type }) => type === "event").length, 1);
  assert.doesNotMatch(JSON.stringify(sent), /private native failure/);
  assert.equal(sent.filter(({ type }) => type === "ack").length, 2);
});

test("normalized driver output waits in memory for the same runtime channel to reconnect", () => {
  const first = [];
  const second = [];
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send: (message) => first.push(message),
    execute() {},
  });
  runtime.event("session-1", {
    type: "agent_message_chunk",
    data: { turnId: "turn-1", text: "first" },
  });
  runtime.disconnect();
  runtime.event("session-1", {
    type: "agent_message_chunk",
    data: { turnId: "turn-1", text: "while disconnected" },
  });
  runtime.transition("session-1", {
    type: "complete_turn", turnId: "turn-1", status: "completed",
  });
  runtime.setSend((message) => second.push(message));

  assert.equal(first.length, 1);
  assert.deepEqual(second.map(({ type }) => type), ["event", "transition"]);
  assert.equal(second[0].event.data.text, "while disconnected");
});

test("a disconnected runtime bounds each Session outbox and keeps the newest recoverable chunks", () => {
  const sent = [];
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send() {},
    execute() {},
    maxOutboxMessages: 2,
  });
  runtime.disconnect();
  for (const text of ["first", "second", "third"]) {
    runtime.event("session-1", {
      type: "agent_message_chunk",
      data: { turnId: "turn-1", text },
    });
  }
  runtime.setSend((message) => sent.push(message));
  assert.deepEqual(sent.map(({ event }) => event.data.text), ["second", "third"]);
});

test("a non-recoverable outbox overflow terminates only the target Session", () => {
  const sent = [];
  const stopped = [];
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send() {},
    execute() {},
    terminate: (sessionId) => stopped.push(sessionId),
    maxOutboxMessages: 2,
  });
  runtime.disconnect();
  runtime.transition("session-a", { type: "admit" });
  runtime.transition("session-a", { type: "begin_turn", turnId: "turn-a" });
  runtime.transition("session-b", { type: "admit" });
  runtime.transition("session-a", {
    type: "complete_turn", turnId: "turn-a", status: "completed",
  });
  runtime.setSend((message) => sent.push(message));

  assert.deepEqual(stopped, ["session-a"]);
  assert.deepEqual(sent.filter(({ sessionId }) => sessionId === "session-a"), [{
    type: "transition",
    generation: "generation-1",
    sessionId: "session-a",
    action: { type: "terminate", reason: "resource_exhausted" },
  }]);
  assert.equal(sent.filter(({ sessionId }) => sessionId === "session-b").length, 1);
});

test("a Session receipt overflow rejects another effect and converges terminal", async () => {
  const sent = [];
  const effects = [];
  const runtime = new SessionRuntime({
    generation: "generation-1",
    send: (message) => sent.push(message),
    execute: async (sessionId, command) => effects.push([sessionId, command.commandId]),
    maxReceipts: 1,
  });
  for (const commandId of ["command-1", "command-2"]) {
    await runtime.receive(JSON.stringify({
      type: "command",
      generation: "generation-1",
      sessionId: "session-1",
      command: { commandId, kind: "steer", payload: {} },
    }));
  }
  assert.deepEqual(effects, [["session-1", "command-1"]]);
  assert.deepEqual(sent.at(-1), {
    type: "transition",
    generation: "generation-1",
    sessionId: "session-1",
    action: { type: "terminate", reason: "resource_exhausted" },
  });
});
