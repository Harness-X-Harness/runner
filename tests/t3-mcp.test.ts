import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Resolve the same official MCP client used by the Runner native agent fixture.
const require = createRequire(new URL("../.github/actions/agent-runtime/package.json", import.meta.url));
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client") as
  typeof import("../.github/actions/agent-runtime/node_modules/@modelcontextprotocol/client/dist/esm/index.js");
const execute = promisify(execFile);
const enabled = process.env.T3_MCP_LIVE === "1";

type Issued = { sessionId: string; token: string };
async function session(scopes: string[]): Promise<Issued> {
  const args = ["auth", "session", "issue",
    ...scopes.flatMap(scope => ["--scope", scope]), "--ttl", "5m", "--json"];
  const { stdout } = await execute("t3", args, { timeout: 20_000, maxBuffer: 8192 });
  const data: unknown = JSON.parse(stdout);
  if (typeof data !== "object" || !data || !("sessionId" in data) || !("token" in data) ||
      typeof data.sessionId !== "string" || typeof data.token !== "string") {
    throw new Error("T3_SESSION_FORMAT_UNEXPECTED");
  }
  return { sessionId: data.sessionId, token: data.token };
}

async function revoke(sessionId: string) {
  await execute("t3", ["auth", "session", "revoke", sessionId], { timeout: 20_000 });
}

test("independent standard MCP client accesses real T3 with native read-only bearer and revocation", {
  skip: !enabled && "Requires T3_MCP_LIVE=1 and a real local T3 server",
  timeout: 90_000,
}, async t => {
  const endpoint = new URL(process.env.T3_MCP_URL ?? "http://127.0.0.1:3773/mcp");
  assert.equal(endpoint.hostname, "127.0.0.1", "test bearer tokens must never target an arbitrary host");
  assert.equal(endpoint.protocol, "http:");
  const issued = await session(["orchestration:read"]);
  t.after(() => revoke(issued.sessionId).catch(() => {}));
  const client = new Client({ name: "runner-native-t3-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: "Bearer " + issued.token } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some((item: { name: string }) => item.name === "t3_project_list"),
    "T3 must advertise the real project tool");
  const projects = await client.callTool({ name: "t3_project_list", arguments: { cursor: 0, limit: 10 } });
  assert.equal(projects.isError, undefined, "a read-only session should read native T3 projects");
  assert.ok(projects.structuredContent && "projects" in projects.structuredContent);
  // A read-only token must not create a thread. Error is returned either as an
  // MCP error response or as an unsuccessful tool result.
  let unauthorized = false;
  try {
    const mutation = await client.callTool({ name: "t3_thread_launch", arguments: {
      scratch: true, title: "Unauthorized launch", message: "Do not execute",
    } });
    unauthorized = mutation.isError === true;
  } catch { unauthorized = true; }
  assert.equal(unauthorized, true, "read-only session must not launch an agent");
  await revoke(issued.sessionId);
  await assert.rejects(client.listTools(), "revoked bearer session must be rejected");
});
