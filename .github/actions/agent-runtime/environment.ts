import { withAcpAgent, type AgentProcess, type ClientHandlers } from "./acp-client.ts";
import type { T3ServiceState } from "./t3-service.ts";
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

export type EnvironmentServices = { read(): { t3: T3ServiceState }; subscribe(changed: () => void): () => void;
  issuePairing?(origin: string, signal: AbortSignal): Promise<string> };

export type EnvironmentPort = {
  execute(taskId: string, input: unknown): Promise<OperationResult>;
  cancel(taskId: string): Promise<void>;
  inputs: EnvironmentInput;
  ciWaits: EnvironmentCiWaits;
  output: EnvironmentOutput;
  agentState?: { read(): AgentModelState; subscribe(changed: () => void): () => void };
  services?: EnvironmentServices;
  command(input: CommandInput): ReturnType<EnvironmentRuntime["command"]>;
  agent(input: string | AgentTurn): ReturnType<EnvironmentRuntime["agent"]>;
  /** Seals admission and awaits the active operation, not the outer process scope. */
  close(): Promise<void>;
  signal: AbortSignal;
};

/** Resolves after serving ends, command cleanup and optional native ACP exit. */
export async function withEnvironment<T>(
  process: Omit<AgentProcess, "signal"> | null,
  executor: "codex" | "grok" | "t3",
  deadline: number,
  commandEnv: CommandContext["env"],
  handlers: ClientHandlers,
  serve: (environment: EnvironmentPort) => Promise<T>,
  signal?: AbortSignal,
  dependencies?: { workspace?: string;
    readAgentReport?: (executor: "codex" | "grok", signal: AbortSignal) => Promise<AgentModelReport>;
    services?: EnvironmentServices },
): Promise<T> {
  const workspace = process?.workspace ?? dependencies?.workspace;
  if (!workspace || (executor === "t3") !== (process === null)) {
    throw new Error("INVALID_ENVIRONMENT_RUNTIME");
  }
  const providerExecutor: "codex" | "grok" | undefined = executor === "t3" ? undefined : executor;
  const inputs = new EnvironmentInput();
  const ciWaits = new EnvironmentCiWaits();
  let ciTool: Awaited<ReturnType<typeof startGithubWaitTool>> | undefined;
  let operations: EnvironmentOperations | undefined;
  const agentObservers = new Set<() => void>();
  const runtime = new EnvironmentRuntime({ workspace, deadline, env: commandEnv,
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
    if (providerExecutor) ciTool = await startGithubWaitTool(async (input, toolSignal) => {
      const active = operations?.current();
      if (!active || active.cancelling) throw new Error("CI_WAIT_WITHOUT_ACTIVE_TASK");
      return waitForGithubRun(input, commandEnv.GH_TOKEN ?? "", AbortSignal.any([lifetime.signal, toolSignal]),
        (target, signal) => ciWaits.register(active.taskId, target, signal));
    });
    const servePort = async (nativeAgent?: EnvironmentPort["agent"]): Promise<T> => {
      serving = true;
      const port: EnvironmentPort = {
        execute: (taskId, input) => operations!.execute(taskId, input),
        cancel: taskId => { inputs.cancel(taskId); ciWaits.cancel(taskId); return operations!.cancel(taskId); },
        inputs, ciWaits, services: dependencies?.services,
        ...(providerExecutor ? { agentState: {
          read: () => runtime.agentState(providerExecutor),
          subscribe: (changed: () => void) => {
            agentObservers.add(changed); return () => { agentObservers.delete(changed); };
          },
        } } : {}),
        get output() { return operations!.output; },
        command: input => {
          if (lifetime.signal.aborted) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_CLOSING"));
          return runtime.command(input);
        },
        agent: input => {
          if (lifetime.signal.aborted) return Promise.reject(new Error("ENVIRONMENT_RUNTIME_CLOSING"));
          return nativeAgent ? nativeAgent(input) : Promise.reject(new Error("AGENT_UNAVAILABLE"));
        },
        close: () => lifetime.close(), signal: lifetime.signal,
      };
      operations = new EnvironmentOperations(port, () => runtime.cancelActive());
      try { return await serve(port); }
      finally { await lifetime.close(); }
    };
    if (!providerExecutor) {
      // T3 owns its browser/MCP agents; Runner exposes only command operations.
      return await servePort();
    }
    const nativeProcess = process!;
    return await withAcpAgent({ ...nativeProcess, signal: startupAbort.signal }, { ...handlers,
      createElicitation: elicit,
      grokQuestion: request => answerGrokQuestion(request, async form => elicit(form)),
    }, client => client.buildSession({ cwd: workspace,
      mcpServers: [...(nativeProcess.mcpServers ?? []), ciTool!.config] }).withSession(async session => {
      lifetime.signal.throwIfAborted();
      if (providerExecutor === "codex" && session.modes?.currentModeId !== "agent-full-access") {
        throw new Error("CODEX_AGENT_MODE_MISMATCH");
      }
      if (dependencies?.readAgentReport) {
        await runtime.refreshReport(providerExecutor, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)])).catch(() => {});
      }
      return servePort(input => runtime.agent(client, session, providerExecutor, input));
    }));
  } finally {
    signal?.removeEventListener("abort", stop);
    try { await lifetime.close(); } finally { await ciTool?.close(); }
  }
}
