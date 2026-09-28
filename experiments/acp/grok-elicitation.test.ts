import assert from "node:assert/strict";
import test from "node:test";
import { parseGrokForm, grokAnswer } from "../../.github/actions/agent-runtime/grok-elicitation.ts";

test("Grok form keeps its request identity and uses outcome for replies", () => {
  const request = { sessionId: "session", toolCallId: "question", serverName: "probe", mode: "form",
    message: "Marker", requestedSchema: { type: "object", properties: { marker: { type: "string" } } } };
  assert.deepEqual(parseGrokForm(request), request);
  assert.deepEqual(grokAnswer({ action: "accept", content: { marker: "ok" } }), { outcome: "accept", content: { marker: "ok" } });
  assert.deepEqual(grokAnswer({ action: "cancel" }), { outcome: "cancel" });
  assert.deepEqual(grokAnswer({ action: "decline" }), { outcome: "decline" });
});

test("unsupported form payloads and actions are not guessed", () => {
  assert.throws(() => parseGrokForm({ mode: "form" }));
  assert.throws(() => grokAnswer({ action: "future" }));
});
