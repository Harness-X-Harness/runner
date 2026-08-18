import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  ENVIRONMENT_CHANNEL_PROTOCOL,
  SessionRuntime,
  channelProtocols,
} = require("../.github/actions/session-runtime/index.js");

test("runner protocol carries OIDC only in the WebSocket handshake", () => {
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
