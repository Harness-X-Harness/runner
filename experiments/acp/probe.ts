import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import * as acp from "@agentclientprotocol/sdk";
import { withAcpAgent } from "../../.github/actions/agent-runtime/acp-client.ts";
import { startWaitTool } from "./wait-tool.ts";
import { readFinalResponse } from "../../.github/actions/agent-runtime/final-response.ts";
import { AgentRuntime } from "../../.github/actions/agent-runtime/index.ts";
import { withEnvironment } from "../../.github/actions/agent-runtime/environment.ts";
import { providerProcess } from "../../.github/actions/agent-runtime/provider-process.ts";

const evidence: { phase?: string; questionCount?: number; toolCalls?: number; toolDiscoveries?: number; deniedPermissions?: number; reportedMissingTool?: boolean; reportedAccessDenied?: boolean; runtimeSucceeded?: boolean; heldMs?: number; nativeTimeoutObserved?: boolean } = {};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function main() {
  const executor = process.argv[2];
  assert.ok(executor === "grok" || executor === "codex");
  const source = process.argv[3];
  const mode = process.argv[4] ?? "continuity";
  assert.ok(["continuity", "runtime", "environment", "environment-ci", "final", "wait", "wait-cancel", "long-wait", "timeout", "question", "question-later", "question-cancel"].includes(mode));
  const nativeToolConfig = mode === "timeout" || mode === "long-wait";
  const longWaitMs = 600000;
  const longWaitTimeoutSeconds = 660;
  const promptBudgetMs = mode === "long-wait" ? 720000 : 90000;
  const questionMode = mode.startsWith("question");
  assert.ok(source && isAbsolute(source), "An absolute private config root is required");
  const original = parse(await readFile(join(source, `.${executor}/config.toml`), "utf8"));
  const selected = executor === "grok" ? record(original.models).default : original.model_provider;
  assert.equal(typeof selected, "string");
  const name = selected as string;
  const config: Record<string, unknown> = executor === "grok"
    ? { models: { default: name }, model: { [name]: record(original.model)[name] } }
    : { model: original.model, model_provider: name, model_providers: { [name]: record(original.model_providers)[name] } };
  const temporary = await mkdtemp(join(tmpdir(), "harness-acp-"));
  const checks: string[] = [];
  let tool: Awaited<ReturnType<typeof startWaitTool>> | undefined;
  try {
    if (!["continuity", "runtime", "environment", "environment-ci"].includes(mode)) tool = await startWaitTool();
    if (nativeToolConfig && tool) config.mcp_servers = {
      probe: { url: tool.url, tool_timeout_sec: mode === "timeout" ? 2 : longWaitTimeoutSeconds },
    };
    await mkdir(join(temporary, `.${executor}`), { mode: 0o700 });
    await mkdir(join(temporary, "workspace"));
    await writeFile(join(temporary, `.${executor}/config.toml`), stringify(config), { mode: 0o600 });
    let output = "";
    let timeoutObserved = false;
    let questionCount = 0;
    let questionEntered!: () => void;
    let answerQuestion!: (answer: acp.CreateElicitationResponse) => void;
    const enteredQuestion = new Promise<void>(resolve => { questionEntered = resolve; });
    const heldAnswer = new Promise<acp.CreateElicitationResponse>(resolve => { answerQuestion = resolve; });
    const answerMarker = `ANSWER_${randomUUID()}`;
    let onOutput: (() => void) | undefined;
    if (mode === "environment-ci") {
      const holdMs = Number(process.argv[5] ?? "5000");
      assert.ok(Number.isSafeInteger(holdMs) && holdMs >= 1 && holdMs <= 65000);
      const env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, GH_TOKEN: "fixture-not-a-real-token" };
      const originalFetch = globalThis.fetch;
      const seen = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reads = 0;
      // This is provider capability acceptance, not a GitHub or Worker live test.
      globalThis.fetch = async url => {
        assert.equal(String(url), "https://api.github.com/repos/fixture/repo/actions/runs/12/attempts/1");
        assert.equal(seen.size, 1); reads++;
        return Response.json({ id: 12, run_attempt: 1, head_sha: "a".repeat(40),
          repository: { full_name: "fixture/repo" }, status: "in_progress", conclusion: null });
      };
      try {
        await withEnvironment(providerProcess(executor, join(temporary, "workspace"), env), executor,
          Date.now() + 180000, env, {
            sessionUpdate: notification => {
              const update = notification.update;
              if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
                  update.status === "failed" && /timed[\s_-]?out|timeout/i.test(JSON.stringify(update))) evidence.nativeTimeoutObserved = true;
            }, requestPermission: request => {
              const option = /wait_for_github_run/.test(request.toolCall.title ?? "") &&
                request.options.find(value => value.kind === "allow_once");
              if (!option) evidence.deniedPermissions = (evidence.deniedPermissions ?? 0) + 1;
              return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
            },
          }, async environment => {
            const unsubscribe = environment.ciWaits.subscribe(() => {
              for (const wait of environment.ciWaits.pending()) {
                if (seen.has(wait.waitId)) continue;
                seen.add(wait.waitId); evidence.toolCalls = seen.size;
                environment.ciWaits.accept(wait.taskId, wait.waitId);
                const started = performance.now();
                timer = setTimeout(() => {
                  evidence.heldMs = Math.round(performance.now() - started);
                  environment.ciWaits.complete(wait.taskId, wait.waitId, { ...wait.target, conclusion: "success" });
                }, holdMs);
              }
            });
            try {
              evidence.phase = "environment_ci_native_turn";
              const result = await environment.execute("ci-proof", { kind: "agent", prompt:
                `Find the MCP tool wait_for_github_run on server harness, using native discovery if needed. Call it exactly once with repository fixture/repo, runId string 12, runAttempt number 1, revision ${"a".repeat(40)}. Wait for its real result. Do not run shell commands, retry the tool, or do unrelated work. If its conclusion is success, your final answer must be exactly CI_WAIT_OK. Otherwise report CI_WAIT_FAILED.` });
              evidence.runtimeSucceeded = result.ok;
              if (result.ok && "finalResponse" in result.value) {
                evidence.reportedMissingTool = /(?:missing|not available|unavailable|not found|no access|cannot find)/i.test(result.value.finalResponse);
                evidence.reportedAccessDenied = /(?:unauthorized|forbidden|401|403|permission|credential)/i.test(result.value.finalResponse);
              }
              assert.ok(result.ok && "finalResponse" in result.value);
              assert.equal(result.value.finalResponse.trim(), "CI_WAIT_OK");
              assert.equal(seen.size, 1); assert.equal(reads, 1);
              assert.ok((evidence.heldMs ?? 0) >= holdMs);
              checks.push("environment_private_ci_tool_same_native_turn");
            } finally { unsubscribe(); if (timer) clearTimeout(timer); }
          });
      } finally { globalThis.fetch = originalFetch; if (timer) clearTimeout(timer); }
      delete evidence.phase;
    } else if (mode === "environment") {
      const workspace = join(temporary, "workspace");
      const env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary };
      const marker = `ENVIRONMENT_${randomUUID()}`;
      await withEnvironment(providerProcess(executor, workspace, env), executor, Date.now() + 90000, env, {
        sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
      }, async environment => {
        evidence.phase = "environment_commands";
        const write = await environment.execute("write", { kind: "command", argv: [process.execPath, "-e",
          `require('node:fs').writeFileSync('marker.txt', ${JSON.stringify(marker)})`], cwd: ".", timeoutSeconds: 5 });
        assert.ok(write.ok);
        assert.ok("exitCode" in write.value);
        assert.equal(write.value.exitCode, 0);
        const read = await environment.execute("read", { kind: "command", argv: [process.execPath, "-e",
          "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))"], cwd: ".", timeoutSeconds: 5 });
        assert.ok(read.ok);
        assert.ok("stdout" in read.value);
        assert.equal(read.value.stdout, marker);
        checks.push("environment_commands_share_workspace");
        evidence.phase = "environment_agent_read";
        const first = await environment.execute("agent-first", { kind: "agent",
          prompt: "Read marker.txt in the current workspace. Do not change files or do unrelated work. Return only its exact content as your final answer." });
        assert.ok(first.ok);
        assert.ok("status" in first.value && "finalResponse" in first.value);
        assert.equal(first.value.status, "completed");
        assert.equal(String(first.value.finalResponse).trim(), marker);
        evidence.phase = "environment_agent_recall";
        const next = await environment.execute("agent-next", { kind: "agent",
          prompt: "Return only the marker from your previous answer. Do not use tools or read files again." });
        assert.ok(next.ok);
        assert.ok("status" in next.value && "finalResponse" in next.value);
        assert.equal(next.value.status, "completed");
        assert.equal(String(next.value.finalResponse).trim(), marker);
        checks.push("environment_agent_reads_command_workspace", "environment_agent_same_session_recall");
        await environment.close();
        assert.equal(environment.signal.aborted, true);
      });
      delete evidence.phase;
    } else if (mode === "runtime") {
      const marker = `RUNTIME_${randomUUID()}`;
      await writeFile(join(temporary, "workspace", "README.md"), `${marker}\n`, { mode: 0o600 });
      const runtime = new AgentRuntime(executor, { env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary } });
      const deadline = setTimeout(() => { void runtime.close(); }, 90000);
      try {
        const result = await runtime.run({ workingDirectory: join(temporary, "workspace"),
          prompt: "Read the first line of README.md in this working directory using your file tools. Do not change files. Return exactly that line as your final answer, with no other text.",
        });
        assert.equal(result.finalResponse.trim(), marker);
        assert.equal(runtime.closed, true);
        checks.push("production_runtime_read_file_exact_result");
      } finally { clearTimeout(deadline); await runtime.close(); }
    } else await withAcpAgent({
      command: executor === "grok" ? "grok" : fileURLToPath(new URL("./node_modules/.bin/codex-acp", import.meta.url)),
      args: executor === "grok" ? ["agent", "--no-leader", "stdio"] : [],
      extensions: executor === "grok" ? "grok" : undefined,
      workspace: join(temporary, "workspace"),
      env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary },
    }, {
      requestPermission: params => {
        const option = tool && /(wait_for_probe|ask_for_probe)/.test(params.toolCall.title ?? "") &&
          params.options.find(option => option.kind === "allow_once");
        if (!option) evidence.deniedPermissions = (evidence.deniedPermissions ?? 0) + 1;
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      sessionUpdate: notification => {
        const { update } = notification;
        if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
            update.status === "failed" && /timed[\s_-]?out|timeout/i.test(JSON.stringify(update))) timeoutObserved = true;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          output += update.content.text;
          onOutput?.();
        }
      },
      ...(questionMode ? { createElicitation: async (request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> => {
        evidence.questionCount = questionCount + 1;
        assert.equal(request.mode, "form");
        assert.ok("requestedSchema" in request && record(record(request.requestedSchema).properties).marker);
        assert.equal(++questionCount, 1);
        questionEntered();
        if (mode === "question-cancel") return heldAnswer;
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { action: "accept", content: { marker: answerMarker } };
      } } : {}),
    }, async agent => {
      if (mode === "final" && tool) {
        const finalTool = tool;
        const marker = `FINAL_${randomUUID()}`;
        await agent.buildSession({ cwd: join(temporary, "workspace"),
          mcpServers: [{ type: "http", name: "probe", url: tool.url, headers: [] }],
        }).withSession(async session => {
          evidence.phase = "final_tool_entry";
          const pending = session.prompt("First say you will call the tool. Find the MCP tool wait_for_probe on server probe, using native tool discovery if needed, and call it exactly once. Your final answer must be only the exact result from that tool. Do not perform unrelated work.");
          pending.catch(() => {});
          const final = readFinalResponse(session, executor);
          final.catch(() => {});
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                await Promise.race([finalTool.entered, pending.then(() => {
                  evidence.reportedMissingTool = /(?:don't|do not|cannot|can't|no|not).{0,60}(?:tool|access|available)/i.test(output);
                  throw Object.assign(new Error("Tool not called"), { code: "TOOL_NOT_CALLED" });
                })]);
                evidence.phase = "final_result";
                finalTool.release(marker);
                assert.equal((await final).trim(), marker);
                await pending;
                assert.equal(finalTool.calls, 1);
              })(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Probe budget exceeded")), 90000); }),
            ]);
          } finally { clearTimeout(timer); }
        });
        checks.push("final_response_after_tool_without_commentary");
        delete evidence.phase;
        return;
      }
      const session = await agent.request(acp.methods.agent.session.new, {
        cwd: join(temporary, "workspace"),
        mcpServers: tool && !nativeToolConfig ? [{ type: "http", name: "probe", url: tool.url, headers: [] }] : [],
      });
      const marker = `ACP_${randomUUID()}`;
      async function prompt(text: string) {
        output = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            agent.request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId, prompt: [{ type: "text", text }],
            }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Probe budget exceeded"), { code: "PROBE_BUDGET_EXCEEDED" })), promptBudgetMs); }),
          ]);
          return result;
        } finally { clearTimeout(timer); }
      }
      if (mode === "question-later" || mode === "question-cancel") {
        assert.equal((await prompt(`Remember ${marker}. Reply READY. For this turn only, do not use tools.`)).stopReason, "end_turn");
        assert.equal((await prompt("Return only the exact marker from my first message. For this turn only, do not use tools.")).stopReason, "end_turn");
        assert.ok(output.includes(marker));
      }
      if (tool && questionMode) {
        evidence.phase = "question_answer";
        const pending = prompt("Find the MCP tool ask_for_probe on server probe, using native tool discovery if needed, and call it exactly once. Return its exact result. Do not perform unrelated work.");
        if (mode === "question-cancel") {
          await Promise.race([enteredQuestion, pending.then(() => { throw new Error("Question not requested"); })]);
          await agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
          assert.equal((await pending).stopReason, "cancelled");
          const terminalOutput = output;
          answerQuestion({ action: "accept", content: { marker: answerMarker } });
          await new Promise(resolve => setTimeout(resolve, 1000));
          assert.equal(output, terminalOutput);
          assert.equal((await prompt("Return only the marker from my first message. For this turn only, do not use tools.")).stopReason, "end_turn");
          assert.ok(output.includes(marker));
          assert.equal(tool.calls, 1);
          checks.push("question_cancel_late_answer_same_context");
          delete evidence.phase;
          return;
        }
        const result = await pending;
        if (tool.calls === 0) {
          evidence.reportedMissingTool = /(?:don't|do not|cannot|can't|no|not).{0,60}(?:tool|access|available)/i.test(output);
          throw Object.assign(new Error("Target tool was not called"), { code: "TOOL_NOT_CALLED" });
        }
        assert.equal(result.stopReason, "end_turn");
        assert.equal(questionCount, 1);
        assert.ok(output.includes(answerMarker));
        assert.equal(tool.calls, 1);
        checks.push(mode === "question-later" ? "acp_elicitation_after_two_turns" : "acp_elicitation_answer_same_turn");
        delete evidence.phase;
        return;
      }
      if (tool && mode === "long-wait") {
        evidence.phase = "long_wait_tool_entry";
        const pending = prompt("Find the MCP tool wait_for_probe on server probe, using native tool discovery if needed, and call it exactly once. Wait for its result and return the exact marker. Never retry the target tool or perform unrelated work.");
        pending.catch(() => {});
        await Promise.race([tool.entered, pending.then(() => { throw new Error("Tool not called"); })]);
        evidence.phase = "long_wait_pending";
        const started = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>(resolve => { timer = setTimeout(resolve, longWaitMs); }),
            pending.then(() => { throw Object.assign(new Error("Prompt completed before tool release"), { code: "PROMPT_ENDED_BEFORE_RELEASE" }); }),
          ]);
        } finally {
          clearTimeout(timer);
          evidence.heldMs = Math.round(performance.now() - started);
          evidence.nativeTimeoutObserved = timeoutObserved;
        }
        assert.ok(performance.now() - started >= longWaitMs);
        const value = `LONG_WAIT_${randomUUID()}`;
        evidence.phase = "long_wait_result";
        tool.release(value);
        assert.equal((await pending).stopReason, "end_turn");
        assert.ok(output.includes(value));
        assert.equal(tool.calls, 1);
        assert.equal(timeoutObserved, false);
        checks.push("configured_660s_tool_wait_600s_same_turn");
        delete evidence.phase;
        return;
      }
      if (tool && mode === "timeout") {
        const result = await prompt("Find the MCP tool wait_for_probe on server probe, using native tool discovery if needed, and call it exactly once. If it fails, report TOOL_FAILED. Never retry the target tool or perform unrelated work.");
        assert.equal(result.stopReason, "end_turn");
        assert.equal(tool.calls, 1);
        assert.ok(timeoutObserved, "No native tool timeout event observed");
        const terminalOutput = output;
        tool.release(`LATE_${randomUUID()}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(output, terminalOutput);
        checks.push("configured_tool_timeout_late_result_quiet");
        return;
      }
      assert.equal((await prompt(`Remember ${marker}. Reply READY. Do not use tools.`)).stopReason, "end_turn");
      assert.equal((await prompt("Return only the exact marker from my first message. Do not use tools.")).stopReason, "end_turn");
      assert.ok(output.includes(marker));
      checks.push("same_acp_session_two_turns");
      if (tool) {
        let finished = false;
        const pending = prompt("Call probe.wait_for_probe exactly once and return its exact marker. Do not use other tools.");
        pending.then(() => { finished = true; }, () => { finished = true; });
        await Promise.race([tool.entered, pending.then(() => { throw new Error("Tool was not called"); })]);
        if (mode === "wait-cancel") {
          await agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
          assert.equal((await pending).stopReason, "cancelled");
          const terminalOutput = output;
          tool.release(`LATE_${randomUUID()}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          assert.equal(output, terminalOutput, "Late tool result produced new output");
          checks.push("tool_wait_cancel_and_late_result_quiet");
        } else {
          await new Promise(resolve => setTimeout(resolve, 5000));
          assert.equal(finished, false);
          const value = `WAIT_${randomUUID()}`;
          tool.release(value);
          assert.equal((await pending).stopReason, "end_turn");
          assert.ok(output.includes(value));
          checks.push("five_second_tool_wait_same_turn");
        }
        assert.equal(tool.calls, 1);
      }
      let cancellation: Promise<void> | undefined;
      onOutput = () => {
        onOutput = undefined;
        cancellation = agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        cancellation.catch(() => {});
      };
      assert.equal((await prompt("Print integers 1 through 10000 one per line, without omissions. Do not use tools.")).stopReason, "cancelled");
      assert.ok(cancellation, "Cancellation was not sent during output");
      await cancellation;
      checks.push("active_output_native_cancel_confirmed");
      assert.equal((await prompt("Return only the exact marker from my first message. Do not use tools.")).stopReason, "end_turn");
      assert.ok(output.includes(marker));
      checks.push("same_acp_session_after_cancel");
    });
  } finally {
    if (tool) { evidence.toolCalls = tool.calls; evidence.toolDiscoveries = tool.discoveries; }
    await tool?.close();
    await rm(temporary, { recursive: true });
  }
  console.log(JSON.stringify({ executor, status: "partial_pass", checks, processStopped: true, ...evidence }));
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)
    ? error.code : "PROBE_FAILED";
  console.error(JSON.stringify({ status: "failed", code,
    ...(error instanceof acp.RequestError ? { rpcCode: error.code } : {}), ...evidence }));
  process.exitCode = 1;
});
