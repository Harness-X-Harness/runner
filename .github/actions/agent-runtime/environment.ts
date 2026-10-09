import { withAcpAgent, type AgentProcess, type ClientHandlers } from "./acp-client.ts";
import type { AgentModelReport, AgentModelState } from "./agent-model.ts";
import { EnvironmentLifetime } from "./environment-lifetime.ts";
import { EnvironmentRuntime, type AgentTurn } from "./environment-runtime.ts";
import type { CommandContext, CommandInput } from "./command.ts";
import { EnvironmentOperations, type OperationResult } from "./environment-operations.ts";
import { EnvironmentInput } from "./environment-input.ts";
import { answerGrokQuestion } from "./grok-question.ts";
import type { EnvironmentOutput } from "./environment-output.ts";
import { EnvironmentCiWaits } from "./environment-ci-waits.ts";
import { startGithubWaitTool } from "./github-wait-tool.ts";
import { waitForGithubRun } from "./github-run-wait.ts";

export type EnvironmentPort = {
  execute(taskId: string, input: unknown): Promise<OperationResult>;
  cancel(taskId: string): Promise<void>;
  inputs: EnvironmentInput;
  ciWaits: EnvironmentCiWaits;
  output: EnvironmentOutput;
  agentState?: { read(): AgentModelState; subscribe(changed: () => void): () => void };
  command(input: CommandInput): ReturnType<EnvironmentRuntime["command"]>;
  agent(input: string | AgentTurn): ReturnType<EnvironmentRuntime["agent"]>;
  /** Seals admission and awaits the active operation, not the outer process scope. */
  close(): Promise<void>;
  signal: AbortSignal;
};

/** Resolves only after serving ends, slot cleanup completes and ACP process exits. */
export async function withEnvironment<T>(
  process: Omit<AgentProcess, "signal">,
  executor: "codex" | "grok",
  deadline: number,
  commandEnv: CommandContext["env"],
  handlers: ClientHandlers,
  serve: (environment: EnvironmentPort) => Promise<T>,
  signal?: AbortSignal,
  dependencies?: { readAgentReport?: (executor: "codex" | "grok", signal: AbortSignal) => Promise<AgentModelReport> },
): Promise<T> {
  const inputs = new EnvironmentInput();
  const ciWaits = new EnvironmentCiWaits();
  let ciTool: Awaited<ReturnType<typeof startGithubWaitTool>> | undefined;
  let operations: EnvironmentOperations | undefined;
  const agentObservers = new Set<() => void>();
  const runtime = new EnvironmentRuntime({ workspace: process.workspace, deadline, env: commandEnv,
    readAgentReport: dependencies?.readAgentReport,
    onAgentState: () => { for (const changed of agentObservers) changed(); },
    onOutput(text, truncated) {
      const active = operations?.current();
      if (active) operations!.output.append(active.taskId, text, truncated);
    },
  });
  const startupAbort = new AbortController();
  let serving = false;
  const lifetime = new EnvironmentLifetime(deadline, async () => {
    const active = operations?.current();
    if (active) { inputs.cancel(active.taskId); ciWaits.cancel(active.taskId); }
    await runtime.close();
    // There is no consumer to react to the lifetime signal during the handshake.
    if (!serving) startupAbort.abort();
  });
  const stop = () => { void lifetime.close(); };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const elicit: NonNullable<ClientHandlers["createElicitation"]> = request => {
    const active = operations?.current();
    if (!active) throw new Error("INPUT_WITHOUT_ACTIVE_TASK");
    if (lifetime.signal.aborted || active.cancelling) return { action: "cancel" };
    return inputs.request(active.taskId, request);
  };
  try {
    lifetime.signal.throwIfAborted();
    ciTool = await startGithubWaitTool(async (input, toolSignal) => {
      const active = operations?.current();
      if (!active || active.cancelling) throw new Error("CI_WAIT_WITHOUT_ACTIVE_TASK");
      return waitForGithubRun(input, commandEnv.GH_TOKEN ?? "", AbortSignal.any([lifetime.signal, toolSignal]),
        (target, signal) => ciWaits.register(active.taskId, target, signal));
    });
    return await withAcpAgent({ ...process, signal: startupAbort.signal }, { ...handlers,
      createElicitation: elicit,
      grokQuestion: request => answerGrokQuestion(request, async form => elicit(form)),
    },
      client => client.buildSession({ cwd: process.workspace, mcpServers: [...(process.mcpServers ?? []), ciTool!.config] }).withSession(async session => {
        lifetime.signal.throwIfAborted();
        // ACP sets the effective per-turn sandbox independently from CODEX_CONFIG.
        if (executor === "codex" && session.modes?.currentModeId !== "agent-full-access") {
          throw new Error("CODEX_AGENT_MODE_MISMATCH");
        }
        if (dependencies?.readAgentReport) {
          // Unavailable discovery is reported, not replaced by another directory.
          // Commands remain usable; an agent call still validates its own selection.
          await runtime.refreshReport(executor, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)])).catch(() => {});
        }
        serving = true;
        const port: EnvironmentPort = {
          execute: (taskId, input) => operations!.execute(taskId, input),
          cancel: taskId => { inputs.cancel(taskId); ciWaits.cancel(taskId); return operations!.cancel(taskId); },
          inputs, ciWaits,
          agentState: { read: () => runtime.agentState(executor), subscribe: changed => {
            agentObservers.add(changed); return () => { agentObservers.delete(changed); };
          } },
          get output() { return operations!.output; },
          command: input => {
            if (lifetime.signal.aborted) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_CLOSING"));
            return runtime.command(input);
          },
          agent: input => {
            if (lifetime.signal.aborted) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_CLOSING"));
            return runtime.agent(client, session, executor, input);
          },
          close: () => lifetime.close(), signal: lifetime.signal,
        };
        operations = new EnvironmentOperations(port, () => runtime.cancelActive());
        // The serving transport must stop receiving when this signal aborts and
        // finish its own pending delivery before its promise resolves.
        try { return await serve(port); }
        finally { await lifetime.close(); }
      }));
  } finally {
    signal?.removeEventListener("abort", stop);
    try { await lifetime.close(); } finally { await ciTool?.close(); }
  }
}
