import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { withEnvironment } from "../.github/actions/agent-runtime/environment.ts";

const processConfig = { command: process.execPath,
  args: [fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
  workspace: process.cwd(), env: {},
};
const handlers = { sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" as const } }) };

for (const active of [false, true]) test(`provider exit closes Environment without waiting for its deadline, active=${active}`, { timeout: 7000 }, async () => {
  let pid = 0;
  let served: Promise<void> | undefined;
  const scope = withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, environment => served = (async () => {
    const initial = await environment.agent("continuity");
    if (initial.status !== "completed") throw new Error("Expected completion");
    pid = JSON.parse(initial.finalResponse).pid;
    if (active) {
      assert.deepEqual(await environment.execute("crash", { kind: "agent", prompt: "crash" }),
        { ok: false, code: "OPERATION_FAILED" });
    } else process.kill(pid, "SIGTERM");
    if (!environment.signal.aborted) await once(environment.signal, "abort", { signal: AbortSignal.timeout(1000) });
    assert.equal(environment.signal.aborted, true);
    await assert.rejects(environment.execute("next", { kind: "agent", prompt: "continuity" }), /ENVIRONMENT_RUNTIME_CLOSING/);
    await assert.rejects(environment.command({ argv: [process.execPath, "--version"], timeoutSeconds: 1 }), /ENVIRONMENT_RUNTIME_CLOSING/);
  })());
  await assert.rejects(scope);
  // The SDK rejects its scope on EOF independently of the serving callback.
  // Await that callback too so a failed inner assertion cannot be hidden by EOF.
  assert.ok(served);
  await served;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("the first agent call fixes a reported model and effort", { timeout: 7000 }, async () => {
  const report = { models: [
    { id: "gpt-6.1-sol", effort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-5.5", effort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
  ] };
  await withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, async environment => {
    const selected = { model: "gpt-5.5", reasoningEffort: "xhigh" };
    assert.deepEqual(environment.agentState?.read().models, report.models);
    assert.equal(environment.agentState?.read().selection, null);
    assert.deepEqual(await environment.execute("one", { kind: "agent", prompt: "codex-final", ...selected }),
      { ok: true, value: { status: "completed", finalResponse: "FINAL_OK", ...selected } });
    assert.deepEqual(environment.agentState?.read().selection, selected);
    assert.equal(environment.agentState?.read().uncertain, false);
    assert.deepEqual(await environment.execute("two", { kind: "agent", prompt: "codex-final" }),
      { ok: true, value: { status: "completed", finalResponse: "FINAL_OK", ...selected } });
    assert.deepEqual(await environment.execute("three", { kind: "agent", prompt: "codex-final", model: "gpt-6.1-sol" }),
      { ok: false, code: "AGENT_MODEL_CONFLICT" });
  }, undefined, { readAgentReport: async () => report });
  await withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, async environment => {
    assert.deepEqual(await environment.execute("hidden", { kind: "agent", prompt: "codex-final", model: "gpt-reserve" }),
      { ok: false, code: "AGENT_MODEL_REJECTED" });
  }, undefined, { readAgentReport: async () => report });
});

test("lost CI completion ends at the Environment deadline and late delivery cannot revive the wait", { timeout: 8000 }, async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://api.github.com/repos/fixture/repo/actions/runs/12/attempts/1");
    reads++;
    return Response.json({ id: 12, run_attempt: 1, head_sha: "a".repeat(40),
      repository: { full_name: "fixture/repo" }, status: "queued", conclusion: null });
  };
  try {
    const pid = await withEnvironment(processConfig, "codex", Date.now() + 2000,
      { GH_TOKEN: "fixture" }, handlers, async environment => {
        const initial = await environment.agent("continuity");
        assert.equal(initial.status, "completed");
        if (initial.status !== "completed") throw new Error("Expected completion");
        const entered = Promise.withResolvers<void>();
        const unsubscribe = environment.ciWaits.subscribe(() => {
          for (const wait of environment.ciWaits.pending()) {
            environment.ciWaits.accept(wait.taskId, wait.waitId);
            entered.resolve();
          }
        });
        try {
          const turn = environment.execute("lost-ci", { kind: "agent", prompt: "ci-wait" });
          await entered.promise;
          const wait = environment.ciWaits.pending()[0]!;
          // No CI completion is delivered. Only the original hard deadline ends the wait.
          const result = await turn;
          assert.equal(environment.signal.aborted, true);
          assert.equal(reads, 1);
          assert.deepEqual(result, { ok: true, value: { status: "cancelled" } });
          assert.deepEqual(environment.ciWaits.pending(), []);
          environment.ciWaits.complete(wait.taskId, wait.waitId, { ...wait.target, conclusion: "success" });
          assert.deepEqual(environment.ciWaits.pending(), []);
          await assert.rejects(environment.agent("continuity"), /ENVIRONMENT_RUNTIME_CLOSING/);
          return JSON.parse(initial.finalResponse).pid;
        } finally { unsubscribe(); }
      });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { globalThis.fetch = originalFetch; }
});

test("Environment passes private MCP configuration through the native ACP session", async () => {
  await withEnvironment({ ...processConfig, mcpServers: [{ type: "http", name: "fixture",
    url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer fixture" }] }] },
  "codex", Date.now() + 5000, {}, handlers, async environment => {
    const result = await environment.agent("mcp-servers");
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.deepEqual(JSON.parse(result.finalResponse), ["fixture", "harness"]);
  });
});

test("native ACP elicitation resumes the same turn and cancellation releases a pending question", { timeout: 6000 }, async () => {
  await withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, async environment => {
    for (const action of ["answer", "cancel", "close"] as const) {
      const ready = Promise.withResolvers<void>();
      const unsubscribe = environment.inputs.subscribe(() => {
        if (environment.inputs.pending(action).length) ready.resolve();
      });
      const turn = environment.execute(action, { kind: "agent", prompt: "question" });
      await ready.promise;
      unsubscribe();
      const question = environment.inputs.pending(action)[0]!;
      if (action === "answer") {
        environment.inputs.answer(action, question.inputId, { action: "accept", content: { marker: "NATIVE_RESUMED" } });
        const result = await turn;
        assert.ok(result.ok && "finalResponse" in result.value);
        if (result.ok && "finalResponse" in result.value) assert.deepEqual(JSON.parse(result.value.finalResponse),
          { action: "accept", content: { marker: "NATIVE_RESUMED" } });
      } else {
        if (action === "cancel") await environment.cancel(action);
        else await environment.close();
        assert.deepEqual(await turn, { ok: true, value: { status: "cancelled" } });
      }
      assert.deepEqual(environment.inputs.pending(action), []);
      assert.equal(environment.signal.aborted, action === "close");
    }
  });
});

test("targeted cancellation preserves the native session and ignores a late prior-task cancel", { timeout: 6000 }, async () => {
  await withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, async environment => {
    const first = await environment.execute("first", { kind: "agent", prompt: "continuity" });
    const pending = environment.execute("second", { kind: "agent", prompt: "cancel-turn-late" });
    await environment.cancel("first");
    await Promise.all([environment.cancel("second"), environment.cancel("second")]);
    assert.deepEqual(await pending, { ok: true, value: { status: "cancelled" } });
    assert.equal(environment.signal.aborted, false);
    await environment.cancel("second");
    const third = await environment.execute("third", { kind: "agent", prompt: "continuity" });
    assert.ok(first.ok && third.ok && "finalResponse" in first.value && "finalResponse" in third.value);
    if (first.ok && third.ok && "finalResponse" in first.value && "finalResponse" in third.value) {
      assert.equal(JSON.parse(first.value.finalResponse).pid, JSON.parse(third.value.finalResponse).pid);
      assert.equal(JSON.parse(third.value.finalResponse).turn, 2);
    }
  });
});

test("hard deadline cancels a pending native question and rejects its late answer", { timeout: 8000 }, async () => {
  const pid = await withEnvironment(processConfig, "codex", Date.now() + 2000, {}, handlers, async environment => {
    const initial = await environment.agent("continuity");
    assert.equal(initial.status, "completed");
    if (initial.status !== "completed") throw new Error("Expected completion");
    const entered = Promise.withResolvers<void>();
    const unsubscribe = environment.inputs.subscribe(() => {
      if (environment.inputs.pending("deadline-question").length) entered.resolve();
    });
    try {
      const turn = environment.execute("deadline-question", { kind: "agent", prompt: "question" });
      await entered.promise;
      const question = environment.inputs.pending("deadline-question")[0]!;
      assert.equal(environment.signal.aborted, false);
      // No answer or explicit close: only the original hard deadline can release the question.
      assert.deepEqual(await turn, { ok: true, value: { status: "cancelled" } });
      assert.equal(environment.signal.aborted, true);
      assert.deepEqual(environment.inputs.pending(), []);
      assert.throws(() => environment.inputs.answer("deadline-question", question.inputId,
        { action: "accept", content: { marker: "MUST_NOT_RESUME" } }), /INPUT_RESPONSE_CONFLICT/);
      await assert.rejects(environment.agent("continuity"), /ENVIRONMENT_RUNTIME_CLOSING/);
      return JSON.parse(initial.finalResponse).pid;
    } finally { unsubscribe(); }
  });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("immediate command cancellation does not launch its process and leaves the Environment usable", async () => {
  await withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, async environment => {
    const pending = environment.execute("command", { kind: "command",
      argv: [process.execPath, "-e", "process.stdout.write('MUST_NOT_START')"], timeoutSeconds: 2 });
    await environment.cancel("command");
    const result = await pending;
    assert.ok(result.ok && "stopReason" in result.value && result.value.stopReason === "cancelled");
    if (result.ok && "stdout" in result.value) assert.equal(result.value.stdout, "");
    assert.equal(environment.signal.aborted, false);
    assert.equal((await environment.agent("continuity")).status, "completed");
  });
});

test("composed Environment shares workspace, closes admission and observes provider exit", async () => {
  const pid = await withEnvironment(processConfig, "codex", Date.now() + 5000, {}, handlers, async environment => {
    const command = await environment.command({ argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"], timeoutSeconds: 2 });
    const result = await environment.agent("continuity");
    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("Expected completion");
    const native = JSON.parse(result.finalResponse);
    assert.equal(native.cwd, command.stdout);
    const input = { kind: "agent", prompt: "continuity" };
    const original = await environment.execute("same-turn", input);
    const duplicate = await environment.execute("same-turn", input);
    assert.deepEqual(duplicate, original);
    assert.ok(original.ok && "finalResponse" in original.value);
    if (original.ok && "finalResponse" in original.value) assert.equal(JSON.parse(original.value.finalResponse).turn, 2);
    const closed = environment.close();
    assert.equal(environment.signal.aborted, true);
    await assert.rejects(environment.agent("continuity"), /ENVIRONMENT_RUNTIME_CLOSING/);
    await closed;
    return native.pid;
  });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const active of [false, true]) test(`Environment deadline closes ACP scope with active turn=${active}`, { timeout: 7000 }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const ready = Promise.withResolvers<void>();
  const pid = await withEnvironment(processConfig, "codex", Date.now() + 1500, {}, { ...handlers,
    sessionUpdate(notification) {
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" &&
          update.content.text === "cancel-ready") ready.resolve();
    },
  }, async environment => {
    const initial = await environment.agent("continuity");
    if (initial.status !== "completed") throw new Error("Expected completion");
    const pid = JSON.parse(initial.finalResponse).pid;
    const pending = active ? environment.agent("cancel-turn") : undefined;
    if (active) await ready.promise;
    // Exercise expiry during the intended phase, not a machine-speed-dependent handshake.
    assert.equal(environment.signal.aborted, false);
    t.mock.timers.tick(1500);
    assert.equal(environment.signal.aborted, true);
    await environment.close();
    if (pending) assert.deepEqual(await pending, { status: "cancelled" });
    return pid;
  });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
