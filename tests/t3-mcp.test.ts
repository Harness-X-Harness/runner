import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(new URL("../.github/actions/agent-runtime/package.json", import.meta.url));
type NativeMcpClient = {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean; structuredContent?: Record<string, unknown>;
  }>;
};
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client") as {
  Client: new (identity: { name: string; version: string }) => NativeMcpClient;
  StreamableHTTPClientTransport: new (
    endpoint: URL, configuration: { requestInit: { headers: Record<string, string> } }
  ) => unknown;
};
const execute = promisify(execFile);
const enabled = process.env.T3_MCP_LIVE === "1";
const baseUrl = "http://127.0.0.1:3773";
type Json = Record<string, unknown>;

async function cliJson(args: string[]): Promise<Json | Json[]> {
  // Never include raw credential-bearing stdout in test errors or logs.
  try {
    const { stdout } = await execute("t3", args, { timeout: 15_000, maxBuffer: 8192 });
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed as Json;
  } catch { throw new Error("T3_NATIVE_AUTH_CLI_FAILED"); }
}

async function nativeRevoke(kind: "pairing" | "session", id: string): Promise<void> {
  await execute("t3", ["auth", kind, "revoke", id], { timeout: 15_000 }).catch(() => {});
}

async function api(path: string, init: RequestInit): Promise<Json> {
  const response = await fetch(baseUrl + path, { ...init, redirect: "manual",
    signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("T3_OAUTH_REQUEST_FAILED_" + response.status);
  const result: unknown = await response.json().catch(() => null);
  if (!result || typeof result !== "object") throw new Error("T3_OAUTH_RESULT_INVALID");
  return result as Json;
}

/** The real OAuth/PKCE protocol, approved through T3's native one-time pairing code. */
async function oauthMcpAccess(clientName: string) {
  const pairing = await cliJson(["auth", "pairing", "create",
    "--scope", "orchestration:read", "--ttl", "5m", "--json"]) as Json;
  if (typeof pairing.credential !== "string" || typeof pairing.id !== "string") {
    throw new Error("T3_PAIRING_CLI_FORMAT_INVALID");
  }
  const redirectUri = "http://127.0.0.1:38888/callback";
  const registered = await api("/oauth/mcp/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none" }),
  });
  if (typeof registered.client_id !== "string") throw new Error("T3_OAUTH_CLIENT_ID_MISSING");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = {
    response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state: randomUUID(),
    resource: baseUrl + "/mcp",
  };
  const requested = new URLSearchParams(authorization);
  const authStart = await fetch(baseUrl + "/oauth/mcp/authorize?" + requested, {
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  assert.equal(authStart.status, 302, "T3 must provide its native OAuth approval entry");
  assert.ok(new URL(authStart.headers.get("location")!, baseUrl).pathname === "/connect-agent");

  const approval = await api("/oauth/mcp/decision", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorization, decision: {
      _tag: "pairing-code", access: "read-only", code: pairing.credential,
    } }),
  });
  if (typeof approval.redirectTo !== "string") throw new Error("T3_OAUTH_APPROVAL_FAILED");
  const callback = new URL(approval.redirectTo);
  assert.equal(callback.origin, "http://127.0.0.1:38888");
  assert.equal(callback.searchParams.get("state"), authorization.state);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("T3_OAUTH_CODE_MISSING");

  const token = await api("/oauth/mcp/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, client_id: registered.client_id,
      redirect_uri: redirectUri, code_verifier: verifier, resource: authorization.resource,
    }),
  });
  if (typeof token.access_token !== "string" || token.token_type !== "Bearer") {
    throw new Error("T3_OAUTH_TOKEN_INVALID");
  }
  return { accessToken: token.access_token, pairingId: pairing.id };
}

test("independent MCP SDK authenticates via T3 OAuth PKCE, enforces read-only access and revocation", {
  skip: !enabled && "Requires T3_MCP_LIVE=1 and a real local T3 server",
  timeout: 90_000,
}, async t => {
  const name = "runner-native-t3-" + randomUUID().slice(0, 8);
  const credential = await oauthMcpAccess(name);
  t.after(() => nativeRevoke("pairing", credential.pairingId));
  const client = new Client({ name: "runner-t3-oauth-probe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + credential.accessToken } },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const sessions = await cliJson(["auth", "session", "list", "--json"]);
  assert.ok(Array.isArray(sessions), "native T3 session catalog must be queryable");
  const owned = sessions.find((item: Json) => item.subject === "mcp-client" &&
    typeof item.client === "object" && item.client !== null &&
    "label" in item.client && item.client.label === name);
  if (!owned || typeof owned.sessionId !== "string") throw new Error("T3_MCP_SESSION_ID_NOT_FOUND");
  t.after(() => nativeRevoke("session", owned.sessionId as string));

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool: { name: string }) => tool.name === "t3_project_list"));
  const projects = await client.callTool({ name: "t3_project_list", arguments: { cursor: 0, limit: 10 } });
  assert.notEqual(projects.isError, true, "read-only OAuth client should read real projects");
  assert.ok(projects.structuredContent && "projects" in projects.structuredContent);

  let denied = false;
  try {
    const response = await client.callTool({ name: "t3_thread_launch", arguments: {
      scratch: true, title: "Unauthorized", message: "Do not execute",
    } });
    denied = response.isError === true;
  } catch { denied = true; }
  assert.equal(denied, true, "read-only OAuth client must not launch any agent");

  await nativeRevoke("session", owned.sessionId);
  await assert.rejects(client.listTools(), "revoked OAuth client must be rejected");
});
