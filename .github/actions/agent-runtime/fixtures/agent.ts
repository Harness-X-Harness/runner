import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Deterministic protocol fixture, not evidence of any model's capabilities.
let sessions = 0;
const turns = new Map<string, number>();
const sessionServers = new Map<string, string[]>();
const serverConfigs = new Map<string, acp.McpServer[]>();
const cancellations = new Map<string, () => void>();
const connection = acp.agent({ name: "harness-test-agent" })
  .onNotification(acp.methods.agent.session.cancel, ctx => { cancellations.get(ctx.params.sessionId)?.(); })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(acp.methods.agent.session.new, ctx => {
    const sessionId = ++sessions === 1 ? "fixture-session" : `fixture-session-${sessions}`;
    turns.set(sessionId, 0);
    sessionServers.set(sessionId, ctx.params.mcpServers.map(server => server.name));
    serverConfigs.set(sessionId, ctx.params.mcpServers);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ctx => {
    const prompt = ctx.params.prompt.find(block => block.type === "text")?.text;
    if (prompt === "cancel-turn" || prompt === "cancel-turn-late") {
      const completion = Promise.withResolvers<acp.PromptResponse>();
      let earlyCancel = false;
      cancellations.set(ctx.params.sessionId, () => {
        if (prompt === "cancel-turn-late" && !earlyCancel) {
          earlyCancel = true;
          void ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "handler-now-ready" } } });
          return;
        }
        completion.resolve({ stopReason: "cancelled" });
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId, update: { sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cancel-ready" } },
      });
      try { return await completion.promise; }
      finally { cancellations.delete(ctx.params.sessionId); }
    }
    if (prompt === "continuity") {
      const turn = (turns.get(ctx.params.sessionId) ?? 0) + 1;
      turns.set(ctx.params.sessionId, turn);
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", messageId: `turn-${turn}`,
          _meta: { codex: { phase: "final_answer" } },
          content: { type: "text", text: JSON.stringify({ turn, pid: process.pid, cwd: process.cwd() }) } },
      });
      return { stopReason: "end_turn" };
    }
    if (prompt === "hold") return new Promise<acp.PromptResponse>(() => {});
    if (prompt === "crash") process.exit(2);
    if (prompt === "grok-question") await ctx.client.request("_x.ai/ask_user_question", { sessionId: ctx.params.sessionId, questions: [] });
    if (prompt === "permission") {
      const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId, toolCall: { toolCallId: "test", title: "command" },
        options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }],
      });
      if (permission.outcome.outcome !== "selected") throw new Error("Permission rejected");
    }
    if (prompt === "malformed") {
      // Synthetic private data deliberately reaches a dependency error path.
      const method: string = "session/update";
      await ctx.client.notify(method, { sessionId: "fixture-session", update: {
        sessionUpdate: "PRIVATE_FIXTURE_MARKER", content: { type: "text", text: "PRIVATE_FIXTURE_MARKER" },
      } });
    }
    if (["grok-final", "codex-final", "PRIVATE_PROMPT", "permission", "malformed"].includes(prompt ?? "")) {
      if (process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || process.env.GITHUB_TOKEN) throw new Error("Unexpected control-plane authority");
      for (const [text, method] of [["private commentary", "_x.ai/session_notification"], ["FINAL_OK", "_x.ai/session/update"]]) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: text, _meta: { codex: { phase: text === "FINAL_OK" ? "final_answer" : "commentary" } },
            content: { type: "text", text: prompt === "PRIVATE_PROMPT" && text === "FINAL_OK" ? "PRIVATE_FINAL" : text } },
        });
        await ctx.client.notify(method, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "response_completed", stop_reason: "end_turn" },
        });
      }
      return { stopReason: "end_turn" };
    }
    let text = "ACP_OK";
    if (prompt === "ci-wait") {
      const server = serverConfigs.get(ctx.params.sessionId)?.find(value => value.name === "harness");
      if (!server || !("type" in server) || server.type !== "http") throw new Error("MCP_CONFIG_MISSING");
      const client = new Client({ name: "native-agent-fixture", version: "1" });
      const cancelled = new AbortController();
      cancellations.set(ctx.params.sessionId, () => cancelled.abort());
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
        }));
        const result = await client.callTool({ name: "wait_for_github_run", arguments: {
          repository: "fixture/repo", runId: "12", runAttempt: 1, revision: "a".repeat(40),
        } }, { signal: cancelled.signal });
        if (cancelled.signal.aborted) return { stopReason: "cancelled" };
        text = JSON.stringify(result);
      } catch (error) {
        if (cancelled.signal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally { cancellations.delete(ctx.params.sessionId); await client.close(); }
    }
    if (prompt === "mcp-servers") text = JSON.stringify(sessionServers.get(ctx.params.sessionId));
    if (prompt === "question" || prompt === "stream-question") {
      if (prompt === "stream-question") {
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE_REASONING" } } });
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId: "commentary",
            _meta: { codex: { phase: "commentary" } }, content: { type: "text", text: "VISIBLE_BEFORE_INPUT" } } });
      }
      const answer = await ctx.client.request(acp.methods.client.elicitation.create, {
        sessionId: ctx.params.sessionId, mode: "form", message: "Test marker",
        requestedSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
      });
      if (answer.action === "cancel") return { stopReason: "cancelled" };
      text = JSON.stringify(answer);
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: "fixture-final",
        _meta: { codex: { phase: "final_answer" } }, content: { type: "text", text } },
    });
    return { stopReason: "end_turn" };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

await connection.closed;
