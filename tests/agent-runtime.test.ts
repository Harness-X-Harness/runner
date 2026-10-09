import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { withAcpAgent } from "../.github/actions/agent-runtime/acp-client.ts";
import { readAgentTurn, readFinalResponse } from "../.github/actions/agent-runtime/final-response.ts";
import { methods } from "../.github/actions/agent-runtime/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { EnvironmentRuntime } from "../.github/actions/agent-runtime/environment-runtime.ts";
import { providerProcess } from "../.github/actions/agent-runtime/provider-process.ts";
import { withEnvironment } from "../.github/actions/agent-runtime/environment.ts";

test("Codex launch enables native user questions outside plan mode", () => {
  const process = providerProcess("codex", "/workspace", {});
  const config = JSON.parse(process.env.CODEX_CONFIG!);
  assert.deepEqual(config.features, { default_mode_request_user_input: true });
  assert.equal(Object.keys(config).some(key => key.startsWith("features.")), false);
  assert.equal(config.approval_policy, "never");
  assert.equal(config.sandbox_mode, "danger-full-access");
});

const fixturePath = fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url));
test("Grok authenticates its native model catalog with the configured provider key", () => {
  const env = { MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY" };
  const child = providerProcess("grok", "/workspace", env);
  assert.equal(child.env.XAI_API_KEY, env.MINI_END_USER_KEY);
  assert.equal(providerProcess("codex", "/workspace", env).env.XAI_API_KEY, undefined);
  assert.deepEqual(env, { MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY" });
});

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

test("Environment returns final text and native permission works for both providers", async () => {
  for (const executor of ["codex", "grok"] as const) {
    await withEnvironment({ command: process.execPath, args: [fixturePath], workspace: process.cwd(), env: {},
      extensions: executor === "grok" ? "grok" : undefined }, executor, Date.now() + 10000, {}, {
      sessionUpdate: () => {}, requestPermission: request => ({ outcome: {
        outcome: "selected", optionId: request.options.find(option => option.kind === "allow_once")!.optionId,
      } }),
    }, async environment => {
      for (const prompt of [`${executor}-final`, "permission"]) {
        const result = await environment.agent(prompt);
        assert.equal(result.status, "completed");
        if (result.status === "completed") assert.equal(result.finalResponse, "FINAL_OK");
      }
    });
  }
});

test("production Environment supervisor suppresses diagnostics and forwards stop", async () => {
  for (const mode of ["malformed", "crash", "missing", "stop"] as const) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL(
      "../.github/actions/agent-runtime/fixtures/run.ts", import.meta.url)), mode], { timeout: 10000 });
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /PRIVATE_FIXTURE_MARKER|Error handling notification|fixture-session/);
    const result = JSON.parse(stdout);
    if (mode === "crash" || mode === "missing") assert.deepEqual(result, { error: "ENVIRONMENT_RUNTIME_FAILED" });
    else if (mode === "stop") assert.deepEqual(result, { stopped: true });
    else assert.ok(result.completed === true || result.error === "ENVIRONMENT_RUNTIME_FAILED");
  }
});

test("production supervisor publishes only typed reconnect facts, keeping native diagnostics private", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL(
    "../.github/actions/agent-runtime/fixtures/run.ts", import.meta.url)), "diagnostic"], { timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { completed: true });
  assert.deepEqual(stderr.trim().split("\n").map(line => JSON.parse(line)), [
    { event: "environment_reconnect_failure", category: "runner_identity", observedAt: 1 },
    { event: "environment_reconnect_failure", category: "transport_closed", observedAt: 2, closeCode: 1001 },
  ]);
  assert.doesNotMatch(`${stdout}${stderr}`, /PRIVATE_FIXTURE_MARKER/);
});

test("a closed operator log pipe does not end the Environment supervisor", { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL(
    "../.github/actions/agent-runtime/fixtures/run.ts", import.meta.url)), "diagnostic"],
  { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.destroy();
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { completed: true });
});

const reportedModels = { models: [
  { id: "gpt-6.1-sol", effort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
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
  const state: { model?: string; reasoningEffort?: string } = {};
  const client = { async request(_method: string, params: { configId: string; value: string }) {
    requests.push(`${params.configId}:${params.value}`);
    if (params.configId === "model") state.model = params.value;
    if (params.configId === "reasoning_effort") state.reasoningEffort = params.value;
    return { configOptions: [
      { id: "model", currentValue: state.model },
      { id: "reasoning_effort", currentValue: state.reasoningEffort },
    ].filter(option => option.currentValue !== undefined) };
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
    { prompt: "other", model: "gpt-6.1-sol" }), /AGENT_MODEL_CONFLICT/);
  assert.deepEqual(await runtime.agent(client as never, session as never, "codex", { prompt: "again" }),
    { status: "completed", finalResponse: "FINAL_OK", model: "gpt-5.5", reasoningEffort: "high" });
  assert.equal(prompts(), 2);
});

test("an agent receipt uses the executor's current configuration, not a different request", async () => {
  const runtime = modelRuntime();
  const { session, prompts } = configSession();
  const client = { async request() {
    return { configOptions: [
      { id: "model", currentValue: "gpt-6.1-sol" },
      { id: "reasoning_effort", currentValue: "high" },
    ] };
  }, async notify() {} };
  await assert.rejects(runtime.agent(client as never, session as never, "codex",
    { prompt: "switch", model: "gpt-5.5", reasoningEffort: "high" }), /AGENT_MODEL_UNCERTAIN/);
  assert.equal(prompts(), 0);
  await assert.rejects(runtime.agent(client as never, session as never, "codex", { prompt: "again" }),
    /AGENT_MODEL_UNCERTAIN/);
  assert.equal(prompts(), 0);
});

test("a partial agent configuration failure does not run another prompt", async () => {
  const runtime = modelRuntime();
  const { session, prompts } = configSession();
  let actual = "gpt-6.1-sol";
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
    { prompt: "correct", model: "gpt-6.1-sol", reasoningEffort: "high" }), /AGENT_MODEL_UNCERTAIN/);
  assert.equal(prompts(), 0);
});
