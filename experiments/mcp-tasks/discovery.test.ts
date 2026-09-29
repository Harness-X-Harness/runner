/// <reference path="../../apps/chatgpt-app/node_modules/@cloudflare/workers-types/index.d.ts" />
// Real protocol and catalog code; synthetic authorization and storage, not production acceptance.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { environmentTaskAuthority } from '../../apps/chatgpt-app/src/environment-task-authority.ts';
import { serveTaskRequest } from '../../apps/chatgpt-app/src/task-methods.ts';

test('official high-level client discovers and reads owner-private catalogs', async t => {
  const environmentId = `env_${'a'.repeat(32)}`;
  const snapshot = { environmentId, executor: 'codex', status: 'ready',
    createdAt: 1, expiresAt: 1000, activeTaskId: null };
  const env = {
    ENVIRONMENT_ADMISSION: { getByName: () => ({ list: async () => [environmentId] }) },
    ENVIRONMENTS: { getByName: () => ({ readEnvironment: async () => snapshot }) },
  } as unknown as Parameters<typeof environmentTaskAuthority>[0];
  const authority = environmentTaskAuthority(env, async () => ({ githubUserId: '123',
    githubAuthorizationKind: 'github_app_scoped', environmentGithubAccessToken: 'fixture',
    oauthScopes: ['environments:use'] }));
  const methods: string[] = [];
  const server = createServer(toNodeHandler({ fetch: async request => {
    methods.push(request.headers.get('mcp-method') ?? request.method);
    return serveTaskRequest(request, authority);
  } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'catalog-probe', version: '1' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  assert.equal(client.getServerVersion()?.name, 'harness-x-harness');
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['agent', 'close_environment', 'command', 'inspect_environment', 'open_environment']);
  const resources = await client.listResources();
  const uri = `harness://environments/${environmentId}`;
  assert.deepEqual(resources.resources.map(resource => resource.uri), [uri]);
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  assert.ok(content && 'text' in content);
  assert.deepEqual(JSON.parse(content.text), snapshot);
  for (const response of [await authority.tools(), await authority.resources(), await authority.readResource(uri)]) {
    assert.equal((response as { ttlMs: number }).ttlMs, 0);
    assert.equal((response as { cacheScope: string }).cacheScope, 'private');
  }
  assert.deepEqual(methods, ['server/discover', 'tools/list', 'resources/list', 'resources/read']);
});
