import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import { parseGrokForm, grokAnswer } from "./grok-elicitation.ts";
import { normalizeGrokNotifications } from "./grok-notifications.ts";

export type AgentProcess = {
  command: string;
  args: string[];
  workspace: string;
  env: NodeJS.ProcessEnv;
  extensions?: "grok";
  mcpServers?: acp.McpServer[];
  signal?: AbortSignal;
};

export type ClientHandlers = Pick<acp.Client, "requestPermission" | "sessionUpdate" | "createElicitation"> & {
  grokQuestion?: (request: unknown) => Promise<unknown>;
  grokExitPlan?: () => Promise<unknown>;
};

// The SDK owns framing, schemas, request correlation and connection lifetime.
// The caller owns permissions, task state and the exact child environment.
export async function withAcpAgent<T>(
  process: AgentProcess,
  handlers: ClientHandlers,
  run: (agent: acp.ClientContext, initialized: acp.InitializeResponse) => Promise<T>,
): Promise<T> {
  process.signal?.throwIfAborted();
  const child = spawn(process.command, process.args, {
    cwd: process.workspace,
    env: process.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = once(child, "close");
  // Consume process errors even when SDK transport failure wins the race.
  closed.catch(() => {});
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  let removeAbort = () => {};
  try {
    const app = acp.client({ name: "harness-runner" })
      .onRequest(acp.methods.client.session.requestPermission, ctx => handlers.requestPermission(ctx.params))
      .onNotification(acp.methods.client.session.update, ctx => handlers.sessionUpdate(ctx.params));
    app.onConnect(connection => {
      const abort = () => connection.close(process.signal?.reason);
      process.signal?.addEventListener("abort", abort, { once: true });
      removeAbort = () => process.signal?.removeEventListener("abort", abort);
      if (process.signal?.aborted) abort();
    });
    if (process.extensions === "grok") {
      if (handlers.grokQuestion) app.onRequest("_x.ai/ask_user_question", value => value, ctx => handlers.grokQuestion!(ctx.params));
      if (handlers.grokExitPlan) app.onRequest("_x.ai/exit_plan_mode", value => value, handlers.grokExitPlan);
    }
    const createElicitation = handlers.createElicitation;
    if (createElicitation) {
      if (process.extensions === "grok") {
        app.onRequest("_x.ai/mcp/elicit", parseGrokForm, async ctx => grokAnswer(await createElicitation(ctx.params)));
      } else app.onRequest(acp.methods.client.elicitation.create, ctx => createElicitation(ctx.params));
    }
    return await app.connectWith(process.extensions === "grok" ? normalizeGrokNotifications(stream) : stream, async agent => {
        const initialized = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
            ...(createElicitation && process.extensions !== "grok" ? { elicitation: { form: {} } } : {}),
          },
        });
        if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error("Unsupported ACP version");
        return run(agent, initialized);
      });
  } finally {
    removeAbort();
    // Let the adapter close its own provider after ACP EOF before escalating.
    child.stdin.end();
    const terminate = setTimeout(() => child.kill("SIGTERM"), 1000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await closed; } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
      child.stdin.destroy();
      child.stdout.destroy();
    }
  }
}
