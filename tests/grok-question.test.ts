import test from "node:test";
import assert from "node:assert/strict";
import { answerGrokQuestion } from "../.github/actions/agent-runtime/grok-question.ts";
import { EnvironmentInput } from "../.github/actions/agent-runtime/environment-input.ts";

const request = { sessionId: "s", toolCallId: "tool", mode: "default", questions: [
  { question: "Language?", multiSelect: false, options: [{ label: "TypeScript", description: "Typed", preview: "type Example = string" }] },
  { question: "Checks?", multiSelect: true, options: [{ label: "Unit", description: "Local tests" }, { label: "Live", description: "Production tests" }] },
  { question: "Other detail?", options: [] },
] };

test("Grok native question maps single/multiple/free-text answers through the standard form receipt", async () => {
  const inputs = new EnvironmentInput();
  const result = answerGrokQuestion(request, form => inputs.request("task", form));
  const pending = inputs.pending("task")[0]!;
  assert.ok(pending);
  inputs.answer("task", pending.inputId, { action: "accept", content: {
    q0: "TypeScript", q1: ["Unit", "Live"], q2_notes: "Keep it simple",
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(await result)), { outcome: "accepted", answers: {
    "Language?": ["TypeScript"], "Checks?": ["Unit", "Live"], "Other detail?": ["Other"],
  }, annotations: { "Language?": { preview: "type Example = string" }, "Other detail?": { notes: "Keep it simple" } } });
});

test("Grok dismiss remains cancelled and duplicate question keys are rejected before prompting", async () => {
  assert.deepEqual(await answerGrokQuestion(request, async () => ({ action: "cancel" })), { outcome: "cancelled" });
  await assert.rejects(answerGrokQuestion({ ...request, questions: [request.questions[0], request.questions[0]] },
    async () => { throw new Error("must not prompt"); }), /DUPLICATE_QUESTION/);
});
