import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { withAcpAgent } from "../../.github/actions/agent-runtime/acp-client.ts";
import { readFinalResponse } from "../../.github/actions/agent-runtime/final-response.ts";

test("SDK stdio transports session requests and streamed updates", async () => {
  const output: string[] = [];
  const result = await withAcpAgent({ command: process.execPath,
    args: [fileURLToPath(new URL("../../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
    workspace: process.cwd(), env: {},
  }, {
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: ({ update }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") output.push(update.content.text);
    },
  }, async agent => {
    const session = await agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    return agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId, prompt: [{ type: "text", text: "probe" }],
    });
  });
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(output, ["ACP_OK"]);
});

test("an unavailable agent rejects without calling the session workflow", async () => {
  let entered = false;
  await assert.rejects(withAcpAgent({
    command: "/nonexistent-harness-test-agent", args: [], workspace: process.cwd(), env: {},
  }, {
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: () => {},
  }, async () => { entered = true; }), { code: "ENOENT" });
  assert.equal(entered, false);
});

test("SDK queue retains Grok response boundaries before stop across consecutive turns", async () => {
  const result = await withAcpAgent({ command: process.execPath,
    args: [fileURLToPath(new URL("../../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
    workspace: process.cwd(), env: {}, extensions: "grok",
  }, {
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: () => {},
  }, async agent => {
    return agent.buildSession(process.cwd()).withSession(async session => {
      const results: string[] = [];
      for (let turn = 0; turn < 3; turn++) {
        const pending = session.prompt("grok-final");
        pending.catch(() => {}); // SDK also delivers failure through nextUpdate().
        results.push(await readFinalResponse(session, "grok"));
        await pending;
      }
      return results;
    });
  });
  assert.deepEqual(result, ["FINAL_OK", "FINAL_OK", "FINAL_OK"]);
});

test("SDK elicitation returns typed input to the pending prompt", async () => {
  const chunks: string[] = [];
  await withAcpAgent({ command: process.execPath,
    args: [fileURLToPath(new URL("../../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
    workspace: process.cwd(), env: {},
  }, {
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: ({ update }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") chunks.push(update.content.text);
    },
    createElicitation: request => {
      assert.equal(request.mode, "form");
      return { action: "accept", content: { marker: "INPUT_OK" } };
    },
  }, async agent => {
    const session = await agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    const result = await agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId, prompt: [{ type: "text", text: "question" }],
    });
    assert.equal(result.stopReason, "end_turn");
  });
  assert.deepEqual(JSON.parse(chunks.join("")), { action: "accept", content: { marker: "INPUT_OK" } });
});
