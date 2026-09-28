import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { GetTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { serveTaskRequest } from '../../apps/chatgpt-app/src/task-methods.ts';

test('Task methods use official transport over HTTP without the core registry gate', async t => {
  const calls: string[] = [];
  const timestamp = new Date().toISOString();
  // Synthetic identity and authority fixture, NOT an OAuth implementation.
  const server = createServer(toNodeHandler({ fetch: async request => {
    const principal = request.headers.get('authorization');
    if (principal !== 'Bearer owner') return new Response(null, { status: 403 });
    return serveTaskRequest(request, { observe: async () => { throw new Error('Unexpected subscription'); },
      tools: async () => { throw new Error('Unexpected discovery'); },
      resources: async () => { throw new Error('Unexpected discovery'); },
      readResource: async () => { throw new Error('Unexpected resource'); },
      observeResources: async () => { throw new Error('Unexpected resource subscription'); },
      call: async () => { throw new Error('Unexpected tool call'); },
      handle: async message => {
      calls.push(message.method);
      if (message.params.taskId === 'throw') throw new Error('PRIVATE_HANDLER_DETAIL');
      if (message.params.taskId === 'invalid-result') return { invalid: true };
      return message.method === 'tasks/get'
        ? { resultType: 'complete', taskId: message.params.taskId, status: 'working',
          createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60000 }
        : { resultType: 'complete' };
    } });
  } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  function call(method: string, options: {
    taskId?: string; name?: string; capability?: boolean; principal?: string;
    params?: Record<string, unknown>; headers?: Record<string, string>;
  } = {}) {
    const taskId = options.taskId ?? 'probe-task';
    return fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${options.principal ?? 'owner'}`,
        'mcp-method': method, 'mcp-name': options.name ?? taskId,
        'mcp-protocol-version': '2026-07-28', ...options.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: {
        taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}),
        ...options.params, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'fixture', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': options.capability === false ? {} : {
            extensions: { 'io.modelcontextprotocol/tasks': {} },
          },
        },
      } }),
    });
  }

  await t.test('get, update and cancel reach the handler', async () => {
    const get = await call('tasks/get');
    assert.equal(get.status, 200);
    const read = await get.json() as { result: unknown };
    assert.equal(GetTaskResultV2Schema.parse(read.result).taskId, 'probe-task');
    for (const method of ['tasks/update', 'tasks/cancel']) {
      const response = await call(method, { params: method === 'tasks/update' ? { inputResponses: {} } : {} });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { result: unknown }).result, { resultType: 'complete' });
    }
    assert.deepEqual(calls, ['tasks/get', 'tasks/update', 'tasks/cancel']);
  });

  await t.test('missing capability, mismatched headers and invalid input have no handler effects', async () => {
    const before = calls.length;
    const invalid: [Parameters<typeof call>[1], number][] = [
      [{ capability: false }, -32021], [{ name: 'different-task' }, -32020],
      [{ headers: { 'mcp-method': 'tasks/get' } }, -32020],
      [{ headers: { 'mcp-protocol-version': '2025-11-25' } }, -32020],
      [{ params: { inputResponses: 'invalid' } }, -32602],
    ];
    for (const [options, code] of invalid) {
      const response = await call('tasks/update', options);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: number } }).error.code, code);
    }
    assert.equal(calls.length, before);
  });

  await t.test('untrusted Principal cannot reach the Task handler', async () => {
    const before = calls.length;
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const response = await call(method, { principal: 'other' });
      assert.equal(response.status, 403);
      assert.equal(await response.text(), '');
    }
    assert.equal(calls.length, before);
  });

  await t.test('encoded Mcp-Name identifies the same Unicode Task ID', async () => {
    const taskId = '任务';
    const response = await call('tasks/get', { taskId, name: `=?base64?${Buffer.from(taskId).toString('base64')}?=` });
    assert.equal(response.status, 200);
    assert.equal(GetTaskResultV2Schema.parse((await response.json() as { result: unknown }).result).taskId, taskId);
  });

  await t.test('handler exceptions and invalid results are not exposed as successes', async () => {
    for (const taskId of ['throw', 'invalid-result']) {
      const response = await call('tasks/get', { taskId });
      const body = await response.text();
      assert.doesNotMatch(body, /PRIVATE_HANDLER_DETAIL/);
      assert.deepEqual(JSON.parse(body).error, { code: -32603, message: 'Task request failed' });
    }
  });
});
