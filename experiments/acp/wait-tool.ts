import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod";

export async function startWaitTool() {
  let enter!: () => void;
  let release!: (value: string) => void;
  let calls = 0;
  let discoveries = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const result = new Promise<string>(resolve => { release = resolve; });
  const server = new McpServer({ name: "harness-wait-probe", version: "1" });
  server.registerTool("wait_for_probe", {
    description: "Wait for the test harness and return its exact marker.", inputSchema: z.object({}),
  }, async () => {
    if (++calls !== 1) throw new Error("Unexpected duplicate probe call");
    enter();
    return { content: [{ type: "text", text: await result }] };
  });
  server.registerTool("ask_for_probe", {
    description: "Ask the test client for a marker and return its exact answer.", inputSchema: z.object({}),
  }, async () => {
    if (++calls !== 1) throw new Error("Unexpected duplicate probe call");
    const answer = await server.server.elicitInput({ mode: "form", message: "Supply the test marker.",
      requestedSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
    });
    return { content: [{ type: "text", text: answer.action === "accept" ? String(answer.content?.marker) : "DECLINED" }] };
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "tools/list") discoveries++;
    onmessage?.(message, extra);
  };
  const http = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => response.destroy());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, entered, release,
    get calls() { return calls; },
    get discoveries() { return discoveries; },
    async close() {
      release("PROBE_STOPPED");
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    },
  };
}
