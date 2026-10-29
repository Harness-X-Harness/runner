import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { privateT3Json, privateT3Command, liveOrigin, t3McpFetch } from "./helpers/t3-live.ts";
import { readT3Descriptor } from "../.github/actions/agent-runtime/t3-readiness.ts";

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
    endpoint: URL, configuration: { requestInit: { headers: Record<string, string> }; fetch: typeof fetch }
  ) => unknown;
};
const enabled = process.env.T3_MCP_LIVE === "1";
// Resolve inside the live test, so disabled tests need no live configuration.
let baseUrl: string;
type Json = Record<string, unknown>;

async function cliJson(args: string[]): Promise<Json | Json[]> {
  // Never include raw credential-bearing stdout in test errors or logs.
  try {
    const result = await privateT3Json(args, { timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error();
    const parsed = result.value;
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed as Json;
  } catch { throw new Error("T3_NATIVE_AUTH_CLI_FAILED"); }
}

async function nativeRevoke(kind: "pairing" | "session", id: string): Promise<void> {
  const result = await privateT3Command(["auth", kind, "revoke", id]);
  if (result.exitCode !== 0) throw new Error("T3_NATIVE_REVOKE_FAILED");
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
async function oauthMcpAccess(clientName: string, cleanup: (fn: () => Promise<void>) => void) {
  try {
    const resource = await api("/.well-known/oauth-protected-resource/mcp", { method: "GET" });
    const metadata = await api("/.well-known/oauth-authorization-server", { method: "GET" });
    assert.ok(resource.resource === baseUrl + "/mcp" && Array.isArray(resource.authorization_servers) &&
      resource.authorization_servers.length === 1 && resource.authorization_servers[0] === baseUrl);
    assert.ok(metadata.issuer === baseUrl && metadata.authorization_endpoint === baseUrl + "/oauth/mcp/authorize" &&
      metadata.token_endpoint === baseUrl + "/oauth/mcp/token" &&
      metadata.registration_endpoint === baseUrl + "/oauth/mcp/register" &&
      Array.isArray(metadata.code_challenge_methods_supported) && metadata.code_challenge_methods_supported.includes("S256"));
    const pairing = await cliJson(["auth", "pairing", "create",
      "--scope", "orchestration:read", "--ttl", "5m", "--json"]) as Json;
    if (typeof pairing.credential !== "string" || typeof pairing.id !== "string") {
      throw new Error("T3_PAIRING_CLI_FORMAT_INVALID");
    }
    cleanup(() => nativeRevoke("pairing", pairing.id as string));
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
    const approvalEntry = new URL(authStart.headers.get("location")!, baseUrl);
    assert.ok(approvalEntry.origin === baseUrl && approvalEntry.pathname === "/connect-agent");

    const approval = await api("/oauth/mcp/decision", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorization, decision: {
        _tag: "pairing-code", access: "read-only", code: pairing.credential,
      } }),
    });
    if (typeof approval.redirectTo !== "string") throw new Error("T3_OAUTH_APPROVAL_FAILED");
    const callback = new URL(approval.redirectTo);
    assert.ok(callback.origin === "http://127.0.0.1:38888" && callback.pathname === "/callback");
    assert.ok(callback.searchParams.get("state") === authorization.state);
    assert.ok(callback.searchParams.get("iss") === baseUrl, "native authorization response must echo its issuer");
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
  } catch { throw new Error("T3_OAUTH_AUTHORIZATION_FAILED"); }
}

test("independent MCP SDK authenticates via T3 OAuth PKCE, enforces read-only access and revocation", {
  skip: !enabled && "Requires T3_MCP_LIVE=1 and a real local T3 server",
  timeout: 90_000,
}, async t => {
  baseUrl = liveOrigin(process.env.T3_MCP_URL || "http://127.0.0.1:3773/mcp", true);
  const signal = AbortSignal.timeout(15_000);
  const local = await readT3Descriptor(liveOrigin(process.env.T3_LOCAL_ORIGIN || "http://127.0.0.1:3773"), signal);
  const remote = await readT3Descriptor(baseUrl, signal);
  assert.ok(local && remote && local.environmentId === remote.environmentId &&
    local.serverVersion === remote.serverVersion, "verify the public target before releasing a pairing code");
  const name = "runner-native-t3-" + randomUUID().slice(0, 8);
  // Registered before OAuth starts: even a failure between token exchange and
  // SDK connect must revoke every session minted for this exact probe.
  t.after(async () => {
    const sessions = await cliJson(["auth", "session", "list", "--json"]);
    if (!Array.isArray(sessions)) throw new Error("T3_NATIVE_SESSION_CATALOG_INVALID");
    for (const session of sessions) {
      if (session.subject === "mcp-client" && session.client && typeof session.client === "object" &&
          "label" in session.client && session.client.label === name && typeof session.sessionId === "string") {
        await nativeRevoke("session", session.sessionId);
      }
    }
  });
  const credential = await oauthMcpAccess(name, fn => t.after(fn));
  const client = new Client({ name: "runner-t3-oauth-probe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + credential.accessToken } },
    fetch: t3McpFetch(baseUrl),
  });
  t.after(async () => { try { await client.close(); } catch { throw new Error("T3_MCP_CLOSE_FAILED"); } });
  // SDK/network errors can include request URLs or upstream response data.
  // Translate every failure before the test reporter sees it.
  try {
    await client.connect(transport);

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
    } catch (error) {
      // A disconnected network is not proof of authorization enforcement.
      denied = !!error && typeof error === "object" && "code" in error &&
        (error.code === -32601 || error.code === -32602);
    }
    assert.equal(denied, true, "read-only OAuth client must not launch any agent");

    await nativeRevoke("session", owned.sessionId);
    const revoked = await fetch(baseUrl + "/mcp", { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: {
        Authorization: "Bearer " + credential.accessToken, "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await revoked.body?.cancel();
    assert.ok(revoked.status === 401 || revoked.status === 403, "native auth must reject revoked access");
    await assert.rejects(client.listTools(), "revoked OAuth client must be rejected");
  } catch { throw new Error("T3_OAUTH_MCP_ACCEPTANCE_FAILED"); }
});
