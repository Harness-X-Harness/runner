import assert from "node:assert/strict";
import test from "node:test";

import {
  channelAllowsSessionAction,
  connectEnvironmentChannel,
  disconnectEnvironmentChannel,
  parseEnvironmentChannelMessage,
} from "../apps/chatgpt-app/src/environment-channel.js";
import { webSocketRunnerToken } from "../apps/chatgpt-app/src/runner-identity.js";

const DESCRIPTOR = {
  pairingUrl: "https://quick.example/pair#token=private",
  t3Url: "https://quick.example",
};

test("exact admitted channel atomically publishes Ready and connected", () => {
  const connected = connectEnvironmentChannel(starting(), {
    generation: "generation-1",
    runId: "123",
    runAttempt: "1",
    connectionId: "connection-1",
    descriptor: DESCRIPTOR,
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  });
  assert.deepEqual(connected, {
    ...starting(),
    ...DESCRIPTOR,
    runAttempt: "1",
    status: "ready",
    channelState: "connected",
    connectionId: "connection-1",
    updatedAt: "2026-08-18T00:00:00.000Z",
  });
});

test("only the same generation, run, and run attempt can connect or reconnect", () => {
  const current = {
    ...starting(),
    ...DESCRIPTOR,
    runAttempt: "1",
    status: "ready",
    channelState: "disconnected",
    connectionId: "connection-old",
  };
  for (const identity of [
    { generation: "generation-stale", runId: "123", runAttempt: "1" },
    { generation: "generation-1", runId: "456", runAttempt: "1" },
    { generation: "generation-1", runId: "123", runAttempt: "2" },
  ]) {
    assert.equal(connectEnvironmentChannel(current, {
      ...identity,
      connectionId: "connection-new",
      descriptor: DESCRIPTOR,
    }), undefined);
  }
  assert.equal(connectEnvironmentChannel({ ...current, status: "closing" }, {
    generation: "generation-1",
    runId: "123",
    runAttempt: "1",
    connectionId: "connection-new",
    descriptor: DESCRIPTOR,
  }), undefined);

  assert.equal(connectEnvironmentChannel(current, {
    generation: "generation-1",
    runId: "123",
    runAttempt: "1",
    connectionId: "connection-new",
    descriptor: DESCRIPTOR,
  }).connectionId, "connection-new");
});

test("only loss of the current socket marks the channel disconnected", () => {
  const current = {
    ...starting(),
    ...DESCRIPTOR,
    runAttempt: "1",
    status: "ready",
    channelState: "connected",
    connectionId: "connection-new",
  };
  assert.equal(disconnectEnvironmentChannel(current, {
    generation: "generation-1",
    runId: "123",
    runAttempt: "1",
    connectionId: "connection-old",
  }), current);
  const disconnected = disconnectEnvironmentChannel(current, {
    generation: "generation-1",
    runId: "123",
    runAttempt: "1",
    connectionId: "connection-new",
  }, () => new Date("2026-08-18T00:01:00.000Z"));
  assert.equal(disconnected.status, "ready");
  assert.equal(disconnected.channelState, "disconnected");
  assert.equal(disconnected.connectionId, undefined);
  assert.equal(disconnected.updatedAt, "2026-08-18T00:01:00.000Z");
});

test("channel accepts only generation-bound acknowledgements and bounded event envelopes", () => {
  const attachment = {
    generation: "generation-1",
    runId: "123",
    runAttempt: "1",
    connectionId: "connection-1",
  };
  assert.deepEqual(parseEnvironmentChannelMessage(JSON.stringify({
    type: "ack",
    generation: "generation-1",
    sessionId: "session-1",
    commandId: "command-1",
  }), attachment), {
    type: "ack",
    generation: "generation-1",
    sessionId: "session-1",
    commandId: "command-1",
  });
  assert.deepEqual(parseEnvironmentChannelMessage(JSON.stringify({
    type: "event",
    generation: "generation-1",
    sessionId: "session-1",
    event: { type: "agent_message_chunk", data: { text: "visible" } },
  }), attachment).event.data, { text: "visible" });
  assert.deepEqual(parseEnvironmentChannelMessage(JSON.stringify({
    type: "transition",
    generation: "generation-1",
    sessionId: "session-1",
    action: { type: "complete_turn", turnId: "turn-1", status: "failed" },
  }), attachment).action, {
    type: "complete_turn", turnId: "turn-1", status: "failed",
  });
  for (const message of [
    new Uint8Array([1, 2]).buffer,
    "not json",
    JSON.stringify({ type: "ack", generation: "generation-old", sessionId: "session-1", commandId: "command-1" }),
    JSON.stringify({ type: "native", generation: "generation-1", payload: { reasoning: "private" } }),
    JSON.stringify({
      type: "transition",
      generation: "generation-1",
      sessionId: "session-1",
      action: { type: "accept_command", commandId: "command-1" },
    }),
  ]) {
    assert.equal(parseEnvironmentChannelMessage(message, attachment), undefined);
  }
});

test("disconnected Environment accepts durable queueing but rejects immediate steer", () => {
  const environment = { channelState: "disconnected" };
  assert.equal(channelAllowsSessionAction(environment, { type: "queue_turn" }), true);
  assert.equal(channelAllowsSessionAction(environment, {
    type: "accept_command",
    kind: "steer",
  }), false);
  assert.equal(channelAllowsSessionAction({ channelState: "connected" }, {
    type: "accept_command",
    kind: "steer",
  }), true);
});

test("runner OIDC is accepted only from the exact WebSocket subprotocol pair", () => {
  const request = new Request("https://runner.example/channel", {
    headers: { "sec-websocket-protocol": "harness.environment.v1, oidc.header.payload.signature" },
  });
  assert.equal(webSocketRunnerToken(request), "header.payload.signature");
  for (const value of [
    "harness.environment.v1",
    "oidc.header.payload.signature",
    "harness.environment.v1, oidc.header.payload.signature, extra",
  ]) {
    assert.throws(
      () => webSocketRunnerToken(new Request("https://runner.example/channel", {
        headers: { "sec-websocket-protocol": value },
      })),
      /identity required/,
    );
  }
});

function starting() {
  return {
    ownerId: "42",
    generation: "generation-1",
    slot: "slot-42",
    status: "starting",
    runId: "123",
    runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123",
    cancelPending: false,
  };
}
