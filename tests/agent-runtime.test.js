import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { CodexProtocolFixture, GrokProtocolFixture } from "./helpers/native-protocol.js";

const require = createRequire(import.meta.url);
const { AgentRuntime } = require("../.github/actions/agent-runtime/index.js");
const { TaskError } = require("../shared/task-errors.js");

function fixture(executor, options) {
  const protocol = executor === "codex" ? new CodexProtocolFixture(options) : new GrokProtocolFixture(options);
  const runtime = new AgentRuntime(executor, { createProcess: (config) => protocol.connect(config), cleanupMs: 20 });
  const result = runtime.run({ prompt: "private prompt", workingDirectory: "/private-workspace" });
  // Install a rejection handler before asynchronous fixture events.
  result.catch(() => {});
  return { protocol, runtime, result };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const failure = (code) => (error) => {
  assert.ok(error instanceof TaskError);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error.toJSON()).sort(), ["code", "message", "retryable"]);
  assert.doesNotMatch(JSON.stringify(error), /private|native-thread|native-session/);
  return true;
};
function codex(protocol, type, params) {
  protocol.pushNotification(type, { threadId: "native-thread", turnId: "native-turn-1", ...params });
}
function grok(protocol, update, method = "session/update") {
  protocol.pushNotification(method, { sessionId: "native-session", update });
}
function response(protocol, text) {
  grok(protocol, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  grok(protocol, { sessionUpdate: "response_completed", stop_reason: "end_turn" }, "_x.ai/session_notification");
}

test("Codex returns the completed final message, not progress, reasoning, tools, or a foreign turn", async () => {
  const { protocol, result } = fixture("codex");
  await tick();
  assert.equal(protocol.options.cwd, "/private-workspace");
  codex(protocol, "item/completed", { item: { type: "agentMessage", phase: "commentary", text: "private progress" } });
  codex(protocol, "item/agentMessage/delta", { delta: "private delta" });
  codex(protocol, "item/completed", { item: { type: "reasoning", text: "private reasoning" } });
  codex(protocol, "item/completed", { item: { type: "agentMessage", phase: "final_answer", text: "FINAL_OK" } });
  codex(protocol, "item/completed", { turnId: "foreign", item: { type: "agentMessage", phase: "final_answer", text: "private foreign" } });
  codex(protocol, "turn/completed", { turn: { id: "native-turn-1", status: "completed" } });
  assert.deepEqual(await result, { finalResponse: "FINAL_OK" });
  assert.equal(protocol.stopped, true);
});

test("Grok uses response boundaries and successful prompt completion, without requiring interject", async () => {
  const { protocol, result } = fixture("grok", { missingInterject: true });
  await tick();
  assert.equal(protocol.options.cwd, "/private-workspace");
  assert.equal(protocol.methods().includes("_x.ai/interject"), false);
  response(protocol, "private earlier commentary");
  grok(protocol, { sessionUpdate: "tool_call", rawInput: "private command" });
  grok(protocol, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } });
  grok(protocol, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FINAL_" } });
  grok(protocol, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
  grok(protocol, { sessionUpdate: "response_completed" }, "_x.ai/session/update");
  protocol.pushNotification("_x.ai/session_notification", {
    sessionId: "foreign", update: { sessionUpdate: "response_completed" },
  });
  protocol.finishPrompt({ stopReason: "end_turn" });
  assert.deepEqual(await result, { finalResponse: "FINAL_OK" });
  assert.equal(protocol.stopped, true);
});

test("empty final output and unsupported completion boundaries fail safely", async () => {
  for (const executor of ["codex", "grok"]) {
    for (const variant of ["empty", "unknown-status", "commentary-only"]) {
      const { protocol, result } = fixture(executor);
      await tick();
      if (executor === "codex") {
        codex(protocol, "item/completed", { item: {
          type: "agentMessage", phase: variant === "commentary-only" ? "commentary" : "final_answer", text: " ",
        } });
        codex(protocol, "turn/completed", { turn: { id: "native-turn-1", status: variant === "unknown-status" ? "future" : "completed" } });
      } else {
        if (variant !== "commentary-only") response(protocol, " ");
        else grok(protocol, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private commentary" } });
        protocol.finishPrompt({ stopReason: variant === "unknown-status" ? "future" : "end_turn" });
      }
      await assert.rejects(result, failure("PROVIDER_PROTOCOL_ERROR"));
    }
  }
});

test("both runtimes classify provider failure and process exit without exposing native errors", async () => {
  for (const executor of ["codex", "grok"]) {
    const first = fixture(executor);
    await tick();
    if (executor === "codex") codex(first.protocol, "turn/completed", { turn: { id: "native-turn-1", status: "failed", error: "private failure" } });
    else first.protocol.failPrompt();
    await assert.rejects(first.result, failure("PROVIDER_EXECUTION_ERROR"));
    const second = fixture(executor);
    await tick();
    second.protocol.options.onExit(new Error("private child failure"));
    await assert.rejects(second.result, failure("PROVIDER_EXECUTION_ERROR"));
    assert.equal(second.protocol.stopped, true);
  }
  await assert.rejects(fixture("codex", { userAgent: "" }).result, failure("PROVIDER_PROTOCOL_ERROR"));
});

test("autonomous approvals work but new human input ends the one-shot operation", async () => {
  for (const executor of ["codex", "grok"]) {
    const { protocol, result } = fixture(executor);
    await tick();
    const params = executor === "codex" ? { threadId: "native-thread", turnId: "native-turn-1" } : { sessionId: "native-session" };
    if (executor === "codex") {
      assert.deepEqual(protocol.requestFromServer("item/fileChange/requestApproval", params), { decision: "accept" });
      assert.deepEqual(protocol.requestFromServer("item/permissions/requestApproval", { ...params, permissions: { network: { enabled: true } } }), {
        permissions: { network: { enabled: true } }, scope: "session",
      });
    } else {
      assert.deepEqual(protocol.requestFromServer("session/request_permission", {
        ...params, options: [{ kind: "allow_once", optionId: "opaque-1", name: "Allow" }],
      }), { outcome: { outcome: "selected", optionId: "opaque-1" } });
    }
    assert.throws(() => protocol.requestFromServer(executor === "codex" ? "item/tool/requestUserInput" : "_x.ai/ask_user_question", params), failure("USER_INPUT_REQUIRED"));
    await assert.rejects(result, failure("USER_INPUT_REQUIRED"));
    assert.equal(protocol.stopped, true);
  }
});

test("cleanup is bounded, idempotent and does not replace the primary result or error", async () => {
  for (const cleanup of [() => { throw new Error("private cleanup error"); }, () => new Promise(() => {})]) {
    const { protocol, runtime, result } = fixture("grok");
    protocol.close = cleanup;
    await tick();
    response(protocol, "OK");
    protocol.finishPrompt({ stopReason: "end_turn" });
    assert.deepEqual(await result, { finalResponse: "OK" });
    await runtime.close();
  }
  const { protocol, runtime, result } = fixture("codex");
  protocol.close = () => { throw new Error("private cleanup"); };
  await tick();
  await runtime.close();
  await assert.rejects(result, failure("PROVIDER_EXECUTION_ERROR"));
  await assert.rejects(() => runtime.run({ prompt: "again", workingDirectory: "/tmp" }), failure("PROVIDER_PROTOCOL_ERROR"));
});
