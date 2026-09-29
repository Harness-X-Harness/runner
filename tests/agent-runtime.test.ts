import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentRuntime, type Executor } from "../.github/actions/agent-runtime/index.ts";
import { TaskError } from "../shared/task-errors.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withAcpAgent } from "../.github/actions/agent-runtime/acp-client.ts";
import { readAgentTurn, readFinalResponse } from "../.github/actions/agent-runtime/final-response.ts";
import { methods } from "../.github/actions/agent-runtime/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { EnvironmentRuntime } from "../.github/actions/agent-runtime/environment-runtime.ts";
import { providerProcess } from "../.github/actions/agent-runtime/provider-process.ts";

test("Codex launch enables native user questions outside plan mode", () => {
  const process = providerProcess("codex", "/workspace", {});
  const config = JSON.parse(process.env.CODEX_CONFIG!);
  assert.equal(config["features.default_mode_request_user_input"], true);
  assert.equal(config.approval_policy, "never");
  assert.equal(config.sandbox_mode, "danger-full-access");
});

const fixturePath = fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url));
const runtime = (executor: Executor) => new AgentRuntime(executor, { env: {}, agentProcess: {
  command: process.execPath, args: [fixturePath], workspace: process.cwd(), env: {},
} });

test("Environment ACP scope keeps one native session across turns and observes process close", async () => {
  const results = await withAcpAgent({ command: process.execPath, args: [fixturePath],
    workspace: process.cwd(), env: {} }, {
    sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  }, agent => agent.buildSession(process.cwd()).withSession(async session => {
    const output: Array<{ turn: number; pid: number }> = [];
    for (let turn = 0; turn < 2; turn++) {
      const pending = session.prompt("continuity");
      const text = readFinalResponse(session, "codex");
      const [, final] = await Promise.all([pending, text]);
      output.push(JSON.parse(final));
    }
    return output;
  }));
  assert.deepEqual(results.map(result => result.turn), [1, 2]);
  assert.equal(results[0]!.pid, results[1]!.pid);
  assert.throws(() => process.kill(results[0]!.pid, 0), { code: "ESRCH" });
});

test("an already closed Environment cannot start an ACP process", async () => {
  const reason = new Error("fixture environment ended");
  await assert.rejects(withAcpAgent({ command: "/must-not-spawn", args: [], workspace: process.cwd(),
    env: {}, signal: AbortSignal.abort(reason) }, {
    sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  }, async () => { throw new Error("must not connect"); }), error => error === reason);
});

test("native turn cancellation drains its stop marker and preserves the same session", { timeout: 7000 }, async () => {
  let ready = Promise.withResolvers<void>();
  await withAcpAgent({ command: process.execPath, args: [fixturePath],
    workspace: process.cwd(), env: {} }, {
    sessionUpdate: notification => {
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" &&
          update.content.text === "cancel-ready") ready.resolve();
    },
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  }, agent => agent.buildSession(process.cwd()).withSession(async session => {
    const runtime = new EnvironmentRuntime({ workspace: process.cwd(), deadline: Date.now() + 5000, env: {} });
    const before = await runtime.agent(agent, session, "codex", "continuity");
    assert.equal(before.status, "completed");
    const pending = runtime.agent(agent, session, "codex", "cancel-turn");
    await ready.promise;
    await assert.rejects(runtime.command({ argv: [process.execPath, "-e", ""], timeoutSeconds: 1 }), /ENVIRONMENT_RUNTIME_BUSY/);
    await assert.rejects(runtime.agent(agent, session, "codex", "continuity"), /ENVIRONMENT_RUNTIME_BUSY/);
    await agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
    assert.deepEqual(await pending, { status: "cancelled" });
    const after = await runtime.agent(agent, session, "codex", "continuity");
    assert.equal(after.status, "completed");
    if (before.status !== "completed" || after.status !== "completed") throw new Error("Missing completed turn");
    const previous = JSON.parse(before.finalResponse);
    const current = JSON.parse(after.finalResponse);
    assert.equal(current.turn, 2);
    assert.equal(current.pid, previous.pid);
    ready = Promise.withResolvers<void>();
    const closingTurn = runtime.agent(agent, session, "codex", "cancel-turn");
    await ready.promise;
    await runtime.close();
    assert.deepEqual(await closingTurn, { status: "cancelled" });
    await assert.rejects(runtime.agent(agent, session, "codex", "continuity"), /ENVIRONMENT_RUNTIME_CLOSING/);
  }));
});

test("both production ACP runtimes return only final text and close before resolving", async () => {
  for (const executor of ["codex", "grok"] as const) {
    const agent = runtime(executor);
    assert.deepEqual(await agent.run({ prompt: `${executor}-final`, workingDirectory: process.cwd() }), { finalResponse: "FINAL_OK" });
    assert.equal(agent.closed, true);
    await agent.close();
    await assert.rejects(agent.run({ prompt: "again", workingDirectory: process.cwd() }), { code: "PROVIDER_PROTOCOL_ERROR" });
  }
});

test("autonomous approval uses ACP; new human input produces a safe one-shot failure", async () => {
  assert.deepEqual(await runtime("grok").run({ prompt: "permission", workingDirectory: process.cwd() }), { finalResponse: "FINAL_OK" });
  for (const [executor, prompt] of [["codex", "question"], ["grok", "grok-question"]] as const) {
    await assert.rejects(runtime(executor).run({ prompt, workingDirectory: process.cwd() }), { code: "USER_INPUT_REQUIRED" });
  }
});

test("startup and child failure are canonical and contain no native diagnostics", async () => {
  const absent = new AgentRuntime("grok", { env: {}, agentProcess: { command: "/missing-agent", args: [], workspace: process.cwd(), env: {} } });
  await assert.rejects(absent.run({ prompt: "test", workingDirectory: process.cwd() }), { code: "PROVIDER_UNAVAILABLE" });
  await assert.rejects(runtime("grok").run({ prompt: "crash", workingDirectory: process.cwd() }), error => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, "PROVIDER_EXECUTION_ERROR");
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE|fixture-session/);
    return true;
  });
});

test("close is idempotent and interrupts an active connection", { timeout: 7000 }, async () => {
  const agent = runtime("grok");
  const pending = agent.run({ prompt: "hold", workingDirectory: process.cwd() });
  pending.catch(() => {});
  await agent.close();
  await agent.close();
  await assert.rejects(pending, { code: "PROVIDER_EXECUTION_ERROR" });
  assert.equal(agent.closed, true);
});

test("dependency diagnostics cannot enter parent stdout or stderr", async () => {
  // Either provider completion or a canonical failure is allowed after invalid input;
  // the property here is that raw dependency diagnostics never reach public logs.
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL(
    "../.github/actions/agent-runtime/fixtures/run.ts", import.meta.url))], { timeout: 7000 });
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /PRIVATE_FIXTURE_MARKER|Error handling notification|fixture-session/);
  const result = JSON.parse(stdout);
 assert.ok(result.finalResponse === "FINAL_OK" || result.code === "PROVIDER_PROTOCOL_ERROR" || result.code === "PROVIDER_EXECUTION_ERROR");
});

const reportedModels = { models: [
  { id: "gpt-6-sol", effort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.5", effort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
] };

function modelRuntime() {
  return new EnvironmentRuntime({ workspace: process.cwd(), deadline: Date.now() + 5000, env: {},
    readAgentReport: async () => reportedModels });
}

function configSession() {
  const updates: Array<{ kind: "session_update"; notification: { sessionId: string; update: object }; update: object } | { kind: "stop"; response: { stopReason: "end_turn" } }> = [];
  let prompts = 0;
  const session = {
    sessionId: "fixture-session",
    async prompt() {
      prompts += 1;
      const update = { sessionUpdate: "agent_message_chunk", messageId: "final",
        _meta: { codex: { phase: "final_answer" } }, content: { type: "text", text: "FINAL_OK" } };
      updates.push({ kind: "session_update", notification: { sessionId: "fixture-session", update }, update });
      updates.push({ kind: "stop", response: { stopReason: "end_turn" } });
      return { stopReason: "end_turn" as const };
    },
    async nextUpdate() {
      const next = updates.shift();
      if (!next) throw new Error("prompt must not start");
      return next;
    },
  };
  return { session, prompts: () => prompts };
}

test("a rejected agent model can be corrected before the native session changes", async () => {
  const runtime = modelRuntime();
  const { session, prompts } = configSession();
  const requests: string[] = [];
  const client = { async request(_method: string, params: { configId: string; value: string }) {
    requests.push(`${params.configId}:${params.value}`);
    return { configOptions: [] };
  }, async notify() {} };
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "bad", model: "gpt-reserve" }), /AGENT_MODEL_REJECTED/);
  assert.deepEqual(requests, []);
  assert.equal(prompts(), 0);
  assert.deepEqual(await runtime.agent(client as never, session as never, "codex",
    { prompt: "use-reported", model: "gpt-5.5", reasoningEffort: "high" }),
    { status: "completed", finalResponse: "FINAL_OK", model: "gpt-5.5", reasoningEffort: "high" });
  assert.equal(prompts(), 1);
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "other", model: "gpt-6-sol" }), /AGENT_MODEL_CONFLICT/);
  assert.deepEqual(await runtime.agent(client as never, session as never, "codex", { prompt: "again" }),
    { status: "completed", finalResponse: "FINAL_OK", model: "gpt-5.5", reasoningEffort: "high" });
  assert.equal(prompts(), 2);
});

test("a partial agent configuration failure does not run another prompt", async () => {
  const runtime = modelRuntime();
  const { session, prompts } = configSession();
  let actual = "gpt-6-sol";
  const client = { async request(_method: string, params: { configId: string; value: string }) {
    if (params.configId === "model") { actual = params.value; return { configOptions: [] }; }
    throw new Error("effort was not applied");
  }, async notify() {} };
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "switch", model: "gpt-5.5", reasoningEffort: "high" }), /AGENT_MODEL_UNCERTAIN/);
  assert.equal(actual, "gpt-5.5");
  assert.equal(prompts(), 0);
  await assert.rejects(runtime.agent(client as never, session as never, "codex", { prompt: "omitted" }),
    /AGENT_MODEL_UNCERTAIN/);
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "retry", model: "gpt-5.5", reasoningEffort: "high" }), /AGENT_MODEL_UNCERTAIN/);
  assert.equal(prompts(), 0);
  assert.equal(actual, "gpt-5.5");
  const command = await runtime.command({ argv: [process.execPath, "-e", "process.stdout.write('COMMAND_OK')"], timeoutSeconds: 2 });
  assert.equal(command.stdout, "COMMAND_OK");
  await runtime.close();
});

test("a failed native model change leaves the agent configuration uncertain", async () => {
  const runtime = modelRuntime();
  const { session, prompts } = configSession();
  const client = { async request(_method: string, params: { configId: string }) {
    if (params.configId === "model") throw new Error("model was not applied");
    throw new Error("effort must not be reached");
  }, async notify() {} };
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "switch", model: "gpt-5.5", reasoningEffort: "high" }), /AGENT_MODEL_UNCERTAIN/);
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "correct", model: "gpt-6-sol", reasoningEffort: "high" }), /AGENT_MODEL_UNCERTAIN/);
  assert.equal(prompts(), 0);
});
