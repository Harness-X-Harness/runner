import assert from "node:assert/strict";
import test from "node:test";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";

test("capacity rejection has identical ordinary and Tasks semantics without dispatch or lifecycle Tasks", async t => {
  const built = await build({
    stdin: { contents: `
      import { EnvironmentObject, EnvironmentAdmissionObject } from './apps/chatgpt-app/src/environment-object.ts';
      import { environmentTaskAuthority } from './apps/chatgpt-app/src/environment-task-authority.ts';
      import { serveTaskRequest } from './apps/chatgpt-app/src/task-methods.ts';
      let dispatches = 0;
      globalThis.fetch = async () => { dispatches++; return Response.json({ workflow_run_id: 123 }); };
      export class TestEnvironment extends EnvironmentObject {
        async initialize(value) {
          if (value.ownerId === '99') throw new Error('ENVIRONMENT_OWNER_CAPACITY PRIVATE_STORAGE_FAILURE');
          return super.initialize(value);
        }
      }
      export { EnvironmentAdmissionObject };
      export default { async fetch(request, env) {
        if (new URL(request.url).pathname === '/dispatches') return Response.json(dispatches);
        const owner = request.headers.get('x-owner');
        return serveTaskRequest(request, environmentTaskAuthority(env, async () => ({
          githubUserId: owner, oauthScopes: ['environments:use'],
          githubAuthorizationKind: 'github_app_scoped', environmentGithubAccessToken: 'PRIVATE_TOKEN',
        })));
      } };`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", cf: false,
    bindings: { ENVIRONMENT_STARTUP_MS: 60000, GITHUB_RUNNER_REPOSITORY: "fixture/runner" },
    durableObjects: {
      ENVIRONMENTS: { className: "TestEnvironment", useSQLite: true },
      ENVIRONMENT_ADMISSION: { className: "EnvironmentAdmissionObject", useSQLite: true },
    },
  });
  t.after(() => mf.dispose());
  const rpc = async (owner: string, method: string, params: Record<string, unknown>, capable = false) => {
    const response = await mf.dispatchFetch("https://fixture/mcp", { method: "POST", headers: {
      "x-owner": owner, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      "mcp-name": String(params.name ?? params.taskId),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": capable ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {},
    } } }) });
    return await response.json() as { result?: { resultType: string; isError?: boolean; taskId?: string;
      structuredContent?: { environmentId?: string } & Record<string, unknown> }; error?: { code: number; message: string } };
  };
  const open = (owner: string, key: string, capable = false) => rpc(owner, "tools/call", {
    name: "open_environment", arguments: { executor: "codex", idempotencyKey: key },
  }, capable);
  const first = await open("1", "first");
  const environmentId = first.result?.structuredContent?.environmentId;
  assert.ok(environmentId);
  assert.match(environmentId, /^env_[a-f0-9]{32}$/);
  const ownerResult = await open("1", "refused");
  assert.equal(ownerResult.error, undefined);
  assert.equal(ownerResult.result?.resultType, "complete");
  assert.equal(ownerResult.result?.isError, true);
  assert.equal(ownerResult.result?.taskId, undefined);
  assert.deepEqual(ownerResult.result?.structuredContent, {
    outcome: "capacity_rejected", capacityKind: "owner", retryable: false,
    existingEnvironment: { environmentId, status: "opening" },
  });
  assert.deepEqual((await open("1", "refused", true)).result, ownerResult.result);
  assert.deepEqual((await open("1", "another-key", true)).result, ownerResult.result);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(["environment-open", "1", "refused"])))).slice(0, 16);
  const refusedTask = `task_${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}_open`;
  assert.equal((await rpc("1", "tasks/get", { taskId: refusedTask }, true)).error?.code, -32602);
  const duplicate = await open("1", "first", true);
  assert.equal(duplicate.result?.resultType, "task");
  for (const owner of ["2", "3", "4"]) assert.equal((await open(owner, "first", true)).result?.resultType, "task");
  const globalResult = await open("5", "refused");
  assert.deepEqual(globalResult.result?.structuredContent, {
    outcome: "capacity_rejected", capacityKind: "global", retryable: true,
  });
  assert.deepEqual((await open("5", "refused", true)).result, globalResult.result);
  assert.deepEqual((await open("1", "owner-wins-at-global-limit", true)).result, ownerResult.result);
  const failed = await open("99", "fault");
  assert.deepEqual(failed.error, { code: -32603, message: "Task request failed" });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|CAPACITY/);
  assert.equal(await (await mf.dispatchFetch("https://fixture/dispatches")).json(), 4);
});
