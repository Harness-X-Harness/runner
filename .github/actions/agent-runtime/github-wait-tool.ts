import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { githubRunInput, exactCompletion, type GithubRunInput, type GithubRunCompletion } from "./github-run-contract.ts";
export type { GithubRunCompletion } from "./github-run-contract.ts";

/** Private loopback transport only. The callback owns coverage, work authority,
 * durable registration and event delivery; this server never polls GitHub. */
export async function startGithubWaitTool(
  wait: (input: GithubRunInput, signal: AbortSignal) => Promise<GithubRunCompletion>,
) {
  const stop = new AbortController();
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const server = new McpServer({ name: "harness-github-events", version: "1" });
  server.registerTool("wait_for_github_run", {
    description: "Wait for this exact CI run attempt and commit to finish, then continue the same turn. Requires configured event coverage and repository access. Does not poll or rerun CI.",
    inputSchema: githubRunInput,
  }, async (input, context) => {
    try {
      const result = exactCompletion(input, await wait(input, AbortSignal.any([stop.signal, context.mcpReq.signal])));
      if (stop.signal.aborted || context.mcpReq.signal.aborted) throw new Error("WAIT_CANCELLED");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      // External errors can contain credentials or private URLs. Do not return them.
      const message = error instanceof Error && error.message === "CI_EVENT_COVERAGE_REQUIRED"
        ? "CI event delivery is not configured for this repository. Waiting is unavailable; no polling was started."
        : error instanceof Error && ["CI_WORK_AUTHORITY_REQUIRED", "CI_WORK_AUTHORITY_DENIED"].includes(error.message)
          ? "The Environment's GitHub work credential cannot read this CI run."
          : "CI wait did not complete. No successful CI outcome was confirmed.";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  await server.connect(transport);
  const http = createServer((request, response) => {
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (actual.length !== expectedAuthorization.length || !timingSafeEqual(actual, expectedAuthorization)) {
      response.writeHead(401).end(); return;
    }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    void transport.handleRequest(request, response).catch(() => response.destroy());
  });
  http.listen(0, "127.0.0.1");
  try { await once(http, "listening"); }
  catch (error) { await server.close(); throw error; }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("LOOPBACK_ADDRESS_UNAVAILABLE");
  let closing: Promise<void> | undefined;
  return {
    config: { type: "http" as const, name: "harness", url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
    close(): Promise<void> {
      closing ??= (async () => {
        stop.abort();
        await server.close();
        http.closeAllConnections();
        await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      })();
      return closing;
    },
  };
}
