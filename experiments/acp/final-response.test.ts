import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { FinalResponse } from "../../.github/actions/agent-runtime/final-response.ts";

const chunk = (text: string, messageId?: string, phase?: string): SessionNotification => ({
  sessionId: "session", update: { sessionUpdate: "agent_message_chunk", messageId,
    content: { type: "text", text }, ...(phase ? { _meta: { codex: { phase } } } : {}) },
});
const boundary = (sessionUpdate: string, sessionId = "session", stop_reason?: string): SessionNotification => ({
  sessionId, update: { sessionUpdate: "session_info_update", _meta: {
    "harness/grok-response": { sessionUpdate, stop_reason },
  } },
});

test("Codex selects only the final message and excludes commentary, notices and foreign sessions", () => {
  const response = new FinalResponse("codex", "session");
  response.update(chunk("private progress", "first", "commentary"));
  response.update(chunk("earlier answer", "second", "final_answer"));
  response.update(chunk("FINAL_", "third", "final_answer"));
  response.update(chunk("OK", "third", "final_answer"));
  response.update(chunk("notice"));
  response.update({ ...chunk("foreign", "fourth"), sessionId: "foreign" });
  assert.equal(response.finish({ stopReason: "end_turn" }), "FINAL_OK");
});

test("Grok uses completed response boundaries, not the concatenated transcript", () => {
  const response = new FinalResponse("grok", "session");
  response.update(chunk("private progress"));
  response.update(boundary("response_completed"));
  response.update(boundary("response_started"));
  response.update(chunk("FINAL_OK"));
  assert.throws(() => response.finish({ stopReason: "end_turn" }));
  response.update(boundary("response_completed", "foreign"));
  assert.throws(() => response.finish({ stopReason: "end_turn" }));
  response.update(boundary("response_completed", "session", "end_turn"));
  assert.equal(response.finish({ stopReason: "end_turn" }), "FINAL_OK");
  assert.throws(() => response.finish({ stopReason: "cancelled" }));
});

test("Codex commentary-only and empty results cannot masquerade as a final answer", () => {
  for (const phase of ["commentary", "final_answer"]) {
    const response = new FinalResponse("codex", "session");
    response.update(chunk(" ", "message", phase));
    assert.throws(() => response.finish({ stopReason: "end_turn" }));
  }
});
