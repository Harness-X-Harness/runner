import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";
import { handleMcpRequest } from "../apps/chatgpt-app/src/mcp.js";
import { dispatchEnvironmentWorkflow } from "../apps/chatgpt-app/src/github.js";
import { legacyStoreRequestAllowed } from "../apps/chatgpt-app/src/legacy-drain.js";

const env = { LEGACY_DRAIN_MODE: "true", TASK_CONTROL_PLANE_URL: "https://runner.example",
  GITHUB_RUNNER_REPOSITORY: "example/runner" };
const props = { githubUserId: "123", oauthScopes: ["environments:manage", "sessions:manage"],
  githubAuthorizationKind: "github_app_scoped", environmentGithubAccessToken: "private",
  mcpControllerGrantId: "grant-a", mcpClientName: "Retained client" };

async function mcp(environment, method, params = {}, grant = props) {
  const response = await handleMcpRequest(new Request("https://runner.example/mcp", {
    method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...(params.name && { "mcp-name": params.name }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "drain-test", version: "1" },
    } } }),
  }), environment, grant, { props: grant });
  return response.json();
}

test("cutover advertises Task execution and only retained legacy reads/close, with no widgets", async () => {
  const list = await mcp(env, "tools/list");
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [
    "run_task", "wait_task", "cancel_task", "list_sessions", "read_session", "close_environment",
  ]);
  assert.ok(list.result.tools.every((tool) => !tool._meta.ui && !tool._meta["openai/outputTemplate"]));
  assert.equal((await mcp(env, "resources/list")).error.code, -32601);
  for (const name of ["open_environment", "start_session", "send_turn", "cancel_queued_turn",
    "interrupt_turn", "respond_to_session", "take_over_session", "stop_session"]) {
    const body = await mcp(env, "tools/call", { name, arguments: {} });
    assert.ok(body.error || body.result?.isError, name);
  }
  const denied = await mcp(env, "tools/call", { name: "run_task", arguments: { executor: "codex", prompt: "private" } });
  assert.equal(denied.result.structuredContent.error.code, "TASK_AUTH_REQUIRED");
  await assert.rejects(dispatchEnvironmentWorkflow(env, "private", {}, () => assert.fail("no dispatch")), { outcome: "rejected" });
});

test("retirement gate denies late claim, Session creation and queued work on actual SQLite", async (t) => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-object.js", import.meta.url));
  const state = fileURLToPath(new URL("../apps/chatgpt-app/src/session-state.js", import.meta.url));
  const built = await build({ stdin: { contents: `
    import { EnvironmentObject } from ${JSON.stringify(source)};
    import { createSessionRecord, terminateGenerationSessions } from ${JSON.stringify(state)};
    export class TestedEnvironment extends EnvironmentObject {
      async fetch(request) {
        if (new URL(request.url).pathname === '/test/closing') {
          const current = await this.ctx.storage.get('environment');
          await this.ctx.storage.put('environment', {...current,status:'closing',cancelPending:false});
          return new Response('ok');
        }
        if (new URL(request.url).pathname === '/test/seed') {
          await this.ctx.storage.put('environment', {ownerId:'123',generation:'old',status:'offline',runId:'900'});
          await createSessionRecord(this.ctx.storage, {sessionId:'session-old',generation:'old',executor:'grok',
            controllerGrantId:'grant-a',controllerClientName:'Retained client',workingDirectory:'/workspace'});
          await terminateGenerationSessions(this.ctx.storage, 'old', 'environment_ended');
          return new Response('ok');
        }
        return super.fetch(request);
      }
    }`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser",
    external: ["cloudflare:workers"] });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-07-23",
    durableObjects: { ENVIRONMENTS: { className: "TestedEnvironment", useSQLite: true } }, bindings: env, cf: false });
  t.after(() => mf.dispose());
  const namespace = await mf.getDurableObjectNamespace("ENVIRONMENTS");
  const stub = namespace.get(namespace.idFromName("github-123"));
  await stub.fetch("http://environment/test/seed");
  const environment = { ...env, ENVIRONMENTS: namespace };
  const before = (await mcp(environment, "tools/call", { name: "read_session", arguments: { sessionId: "session-old" } })).result;
  assert.equal(before.structuredContent.session.phase, "terminal");
  assert.deepEqual(before.structuredContent.session.allowedActions, []);
  assert.deepEqual(Object.keys(before._meta), ["io.modelcontextprotocol/serverInfo"]);
  for (const path of ["/environment/open", "/environment/start-session", "/environment/claim", "/environment/channel",
    "/sessions", "/sessions/session-old"]) {
    const response = await stub.fetch(`http://environment${path}`, { method: "POST", body: JSON.stringify({ type: "queue_turn" }) });
    assert.equal(response.status, 410, path);
  }
  assert.equal((await stub.fetch("http://environment/sessions/session-old/stream")).status, 410);
  const after = (await mcp(environment, "tools/call", { name: "read_session", arguments: { sessionId: "session-old" } })).result;
  assert.deepEqual(after, before);
  assert.equal((await mcp(environment, "tools/call", { name: "list_sessions" })).result.structuredContent.sessions.length, 1);
  assert.equal((await mcp(environment, "tools/call", { name: "close_environment" })).result.structuredContent.status, "offline");
  await stub.fetch("http://environment/test/closing");
  let observed = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/example/runner/actions/runs/900");
    assert.equal(options.method, undefined);
    observed += 1;
    return Response.json({ status: observed === 1 ? "in_progress" : "completed", conclusion: "cancelled" });
  });
  assert.equal((await mcp(environment, "tools/call", { name: "close_environment" })).result.structuredContent.status, "closing");
  assert.equal((await mcp(environment, "tools/call", { name: "close_environment" })).result.structuredContent.status, "offline");
  assert.equal(observed, 2);
  for (const path of ["/environment/dispatch", "/environment/terminal", "/environment/cancel", "/environment/close"]) {
    assert.equal(legacyStoreRequestAllowed(new Request(`http://environment${path}`, { method: "POST" })), true);
  }
});
