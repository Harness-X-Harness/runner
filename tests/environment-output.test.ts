import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EnvironmentOutput } from "../.github/actions/agent-runtime/environment-output.ts";
import { withEnvironment } from "../.github/actions/agent-runtime/environment.ts";
import { ENVIRONMENT_OUTPUT_BYTES } from "../shared/environment-output.ts";

test("output is an immutable bounded UTF-8 prefix with stable revisions after truncation", () => {
  const output = new EnvironmentOutput();
  let changes = 0;
  output.subscribe(() => { changes++; });
  output.begin("one");
  output.append("one", "a".repeat(ENVIRONMENT_OUTPUT_BYTES - 2));
  output.append("one", "😀");
  const snapshot = output.read("one");
  assert.equal(snapshot.text, "a".repeat(ENVIRONMENT_OUTPUT_BYTES - 2));
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.revision, 2);
  output.append("one", "MUST_NOT_FILL_A_HOLE");
  assert.deepEqual(output.read("one"), snapshot);
  snapshot.text = "consumer mutation";
  assert.equal(output.read("one").text.length, ENVIRONMENT_OUTPUT_BYTES - 2);
  assert.equal(changes, 2);
});

const config = { command: process.execPath,
  args: [fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
  workspace: process.cwd(), env: {},
};
const handlers = { sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" as const } }) };

for (const executor of ["codex", "grok"] as const) test(`${executor} visible output and semantic final have distinct consumers`, async () => {
  await withEnvironment({ ...config, extensions: executor === "grok" ? "grok" : undefined }, executor, Date.now() + 5000, {}, handlers, async environment => {
    const result = await environment.execute("turn", { kind: "agent", prompt: `${executor}-final` });
    assert.deepEqual(result, { ok: true, value: { status: "completed", finalResponse: "FINAL_OK",
      ...(executor === "codex" ? { model: "gpt-6-sol", reasoningEffort: "high" } : { model: "grok-4.7", reasoningEffort: "xhigh" }) } });
    assert.equal(environment.output.read("turn").text, "private commentaryFINAL_OK");
  });
});

test("ACP output appears before user input, excludes thoughts and does not replace the final answer", { timeout: 6000 }, async () => {
  await withEnvironment(config, "codex", Date.now() + 5000, {}, handlers, async environment => {
    const questionReady = Promise.withResolvers<void>();
    const unsubscribe = environment.inputs.subscribe(() => {
      if (environment.inputs.pending("stream").length) questionReady.resolve();
    });
    const result = environment.execute("stream", { kind: "agent", prompt: "stream-question" });
    await questionReady.promise;
    unsubscribe();
    assert.equal(environment.output.read("stream").text, "VISIBLE_BEFORE_INPUT");
    const question = environment.inputs.pending("stream")[0]!;
    environment.inputs.answer("stream", question.inputId, { action: "accept", content: { marker: "FINAL_ONLY" } });
    const completed = await result;
    assert.ok(completed.ok && "finalResponse" in completed.value);
    if (completed.ok && "finalResponse" in completed.value) {
      assert.deepEqual(JSON.parse(completed.value.finalResponse), { action: "accept", content: { marker: "FINAL_ONLY" } });
    }
    assert.ok(!environment.output.read("stream").text.includes("PRIVATE_REASONING"));
    const snapshot = environment.output.read("stream");
    await environment.execute("stream", { kind: "agent", prompt: "stream-question" });
    assert.deepEqual(environment.output.read("stream"), snapshot);
  });
});

test("command output is observable before process exit and remains after targeted cancellation", { timeout: 6000 }, async () => {
  await withEnvironment(config, "codex", Date.now() + 5000, {}, handlers, async environment => {
    const changed = Promise.withResolvers<void>();
    const unsubscribe = environment.output.subscribe(() => changed.resolve());
    const result = environment.execute("stream", { kind: "command", timeoutSeconds: 4,
      argv: [process.execPath, "-e", "process.stdout.write('LIVE_COMMAND'); setInterval(()=>{},1000)"] });
    await changed.promise;
    unsubscribe();
    assert.equal(environment.output.read("stream").text, "LIVE_COMMAND");
    await environment.cancel("stream");
    const completed = await result;
    assert.ok(completed.ok && "stdout" in completed.value && completed.value.stdout === "LIVE_COMMAND");
    assert.equal(environment.output.read("stream").text, "LIVE_COMMAND");
  });
});
