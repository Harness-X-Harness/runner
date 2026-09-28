import assert from "node:assert/strict";
import test from "node:test";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { normalizeGrokNotifications } from "../../.github/actions/agent-runtime/grok-notifications.ts";

test("Grok normalization preserves order and leaves requests and other messages unchanged", async () => {
  const messages: AnyMessage[] = [
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "one", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "text" } } } },
    { jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "one", update: { sessionUpdate: "response_completed", stop_reason: "end_turn" } } },
    { jsonrpc: "2.0", id: 7, method: "_x.ai/session_notification", params: {} },
    { jsonrpc: "2.0", id: 8, result: { stopReason: "end_turn" } },
  ];
  const normalized = normalizeGrokNotifications({
    writable: new WritableStream(),
    readable: new ReadableStream({ start(controller) { for (const message of messages) controller.enqueue(message); controller.close(); } }),
  });
  const output: AnyMessage[] = [];
  for await (const message of normalized.readable) output.push(message);
  assert.equal(output[0], messages[0]);
  assert.equal(output[2], messages[2]);
  assert.equal(output[3], messages[3]);
  assert.deepEqual(output[1], { jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "one", update: { sessionUpdate: "session_info_update", _meta: {
      "harness/grok-response": { sessionUpdate: "response_completed", stop_reason: "end_turn" },
    } },
  } });
});
