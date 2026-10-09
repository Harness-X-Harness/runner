import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_MODEL_DEFAULTS, applyAgentSelection, parseCodexModelReport, parseGrokModelReport,
  readExecutorReport, resolveAgentSelection, type AgentModelReport,
} from "../.github/actions/agent-runtime/agent-model.ts";

const codex = parseCodexModelReport({ models: [
  { slug: "gpt-6.1-sol", visibility: "list", default_reasoning_level: "medium",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort })) },
  { slug: "gpt-5.5", visibility: "list", default_reasoning_level: "medium",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(effort => ({ effort })) },
  { slug: "gpt-reserve", visibility: "hide", default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium" }] },
] });
const grok = parseGrokModelReport({ data: [
  { id: "grok-4.7", reasoning_effort: "high", reasoning_efforts: ["low", "medium", "high", "xhigh"].map(value => ({ value })) },
  { id: "grok-4.7-build-fast", reasoning_effort: "high", reasoning_efforts: ["low", "medium", "high", "xhigh"].map(value => ({ value })) },
  { id: "grok-4.5", reasoning_effort: "high", reasoning_efforts: ["low", "medium", "high"].map(value => ({ value })) },
] });

test("omitted agent selection uses the deployment pair when the report lists it", () => {
  assert.deepEqual(AGENT_MODEL_DEFAULTS, {
    codex: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    grok: { model: "grok-4.7", reasoningEffort: "xhigh" },
  });
  assert.deepEqual(resolveAgentSelection({ executor: "codex", report: codex, requested: {} }),
    { model: "gpt-6.1-sol", reasoningEffort: "high" });
  assert.deepEqual(resolveAgentSelection({ executor: "grok", report: grok, requested: {} }),
    { model: "grok-4.7", reasoningEffort: "xhigh" });
});

test("a model alone uses that model's reported effort, and an effort alone stays on the default model", () => {
  assert.deepEqual(resolveAgentSelection({ executor: "codex", report: codex, requested: { model: "gpt-5.5" } }),
    { model: "gpt-5.5", reasoningEffort: "medium" });
  assert.deepEqual(resolveAgentSelection({ executor: "grok", report: grok, requested: { reasoningEffort: "low" } }),
    { model: "grok-4.7", reasoningEffort: "low" });
});

test("hidden, unknown, and unsupported pairs are rejected without substitution", () => {
  for (const requested of [{ model: "gpt-reserve" }, { model: "gpt-6.1-sol", reasoningEffort: "none" }, { model: "missing" }]) {
    assert.throws(() => resolveAgentSelection({ executor: "codex", report: codex, requested }), /AGENT_MODEL_REJECTED/);
  }
  assert.throws(() => resolveAgentSelection({ executor: "grok", report: grok, requested: { reasoningEffort: "max" } }),
    /AGENT_MODEL_REJECTED/);
  assert.deepEqual(resolveAgentSelection({ executor: "grok", report: grok, requested: { model: "grok-4.7-build-fast", reasoningEffort: "xhigh" } }),
    { model: "grok-4.7-build-fast", reasoningEffort: "xhigh" });
  const withoutDefault: AgentModelReport = { models: codex.models.filter(model => model.id !== "gpt-6.1-sol") };
  assert.throws(() => resolveAgentSelection({ executor: "codex", report: withoutDefault, requested: {} }), /AGENT_MODEL_REJECTED/);
});

test("the first resolved pair stays fixed for later agent calls", () => {
  const locked = { model: "gpt-5.5", reasoningEffort: "xhigh" };
  assert.deepEqual(resolveAgentSelection({ executor: "codex", report: codex, requested: {}, locked }), locked);
  assert.deepEqual(resolveAgentSelection({ executor: "codex", report: codex,
    requested: { model: "gpt-5.5", reasoningEffort: "xhigh" }, locked }), locked);
  assert.throws(() => resolveAgentSelection({ executor: "codex", report: codex, requested: { model: "gpt-6.1-sol" }, locked }),
    /AGENT_MODEL_CONFLICT/);
  assert.throws(() => resolveAgentSelection({ executor: "codex", report: codex,
    requested: { reasoningEffort: "xhigh" }, locked }), /AGENT_MODEL_CONFLICT/);
  assert.deepEqual(resolveAgentSelection({ executor: "codex", report: codex,
    requested: { reasoningEffort: "high" }, locked: { model: "gpt-6.1-sol", reasoningEffort: "high" } }),
    { model: "gpt-6.1-sol", reasoningEffort: "high" });
});

test("executor reports keep only their selectable models and efforts", () => {
  assert.deepEqual(codex.models.map(model => model.id), ["gpt-6.1-sol", "gpt-5.5"]);
  assert.deepEqual(grok.models.map(model => model.id), ["grok-4.7", "grok-4.7-build-fast", "grok-4.5"]);
  assert.throws(() => parseCodexModelReport({ models: [] }), /AGENT_MODEL_UNAVAILABLE/);
  assert.throws(() => parseGrokModelReport({ models: [] }), /AGENT_MODEL_UNAVAILABLE/);
});

test("model report reads use the runner credential and do not echo it", async () => {
  let authorization = "";
  const report = await readExecutorReport("codex", {
    MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY", MINI_CODEX_BASE_URL: "https://codex.example/v1",
  }, async (input, init) => {
    assert.equal(String(input), "https://codex.example/v1/models");
    assert.equal(new Headers(init?.headers).has("originator"), false);
    assert.equal(new Headers(init?.headers).has("user-agent"), false);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ models: [{ slug: "gpt-6.1-sol", visibility: "list", default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "high" }, { effort: "medium" }] }] });
  }, new AbortController().signal);
  assert.equal(authorization, "Bearer PRIVATE_PROVIDER_KEY");
  assert.deepEqual(report.models, [{ id: "gpt-6.1-sol", effort: "medium", efforts: ["high", "medium"] }]);
  await assert.rejects(readExecutorReport("grok", {}, fetch, new AbortController().signal), /AGENT_MODEL_UNAVAILABLE/);
  const unavailable = await readExecutorReport("grok", {
    MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY", MINI_GROK_BASE_URL: "https://grok.example/v1",
  }, async () => new Response("no", { status: 503 }), new AbortController().signal).catch((error: unknown) => error);
  assert.ok(unavailable instanceof Error);
  assert.equal(unavailable.message, "AGENT_MODEL_UNAVAILABLE");
  assert.doesNotMatch(unavailable.message, /PRIVATE_PROVIDER_KEY/);
});

test("an unchanged agent selection does not reconfigure the session", async () => {
  const echo = (model: string, reasoningEffort: string) => ({ configOptions: [
    { id: "model", currentValue: model }, { id: "reasoning_effort", currentValue: reasoningEffort },
  ] });
  const calls: string[] = [];
  const current = { model: "gpt-6.1-sol", reasoningEffort: "high" };
  await applyAgentSelection(current, current, async (configId, value) => { calls.push(`${configId}=${value}`); });
  assert.deepEqual(calls, []);
  assert.deepEqual(await applyAgentSelection(current, { model: "gpt-5.5", reasoningEffort: "xhigh" }, async (configId, value) => {
    calls.push(`${configId}=${value}`);
    return echo("gpt-5.5", "xhigh");
  }), { model: "gpt-5.5", reasoningEffort: "xhigh" });
  assert.deepEqual(calls, ["model=gpt-5.5", "reasoning_effort=xhigh"]);
  assert.equal(await applyAgentSelection(current, { model: "gpt-5.5", reasoningEffort: "high" },
    async () => echo("gpt-6.1-sol", "high")), undefined);
});
