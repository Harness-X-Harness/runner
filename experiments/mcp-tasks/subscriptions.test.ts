import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { TaskStatusNotificationV2Schema, type DetailedTaskV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { z } from 'zod';
import { serveTaskRequest, type TaskAuthority } from '../../apps/chatgpt-app/src/task-methods.ts';
import { observeTask } from '../../apps/chatgpt-app/src/task-observation.ts';
import { sseMessages } from '../../tests/helpers/sse-messages.ts';

test('HTTP subscriptions recover authoritative snapshots and isolate owner filters', { timeout: 8000 }, async t => {
  const timestamp = new Date().toISOString();
  const records = new Map(['alice', 'bob'].map(owner => [owner, {
    owner, snapshot: { taskId: owner, status: 'working', createdAt: timestamp,
      lastUpdatedAt: timestamp, ttlMs: 60000 } as DetailedTaskV2,
    listeners: new Set<() => void>(),
  }]));
  let subscriptionCalls = 0;
  let detached = Promise.withResolvers<void>();
  // Deliberately synthetic identities; no OAuth or persistence claim.
  function authority(owner: string): TaskAuthority {
    const read = (id: string) => {
      const record = records.get(id);
      if (!record || record.owner !== owner) throw new Error('Private authority rejection');
      return record.snapshot;
    };
    return {
      async tools() { throw new Error('Unexpected discovery'); },
      async resources() { throw new Error('Unexpected discovery'); },
      async readResource() { throw new Error('Unexpected resource'); },
      async observeResources() { throw new Error('Unexpected resource subscription'); },
      async call() { throw new Error('Unexpected tool call'); },
      async handle(message) { return { ...read(message.params.taskId), resultType: 'complete' }; },
      async observe(ids, signal) {
        subscriptionCalls++;
        return new Map(ids.filter(id => records.get(id)?.owner === owner).map(id => [id, observeTask({
          async read() { return read(id); },
          subscribe(changed: () => void) {
            const record = records.get(id)!;
            record.listeners.add(changed);
            return () => { record.listeners.delete(changed); detached.resolve(); };
          },
        }, signal)]));
      },
    };
  }
  const server = createServer(toNodeHandler({ fetch: request =>
    serveTaskRequest(request, authority(request.headers.get('x-fixture-owner') ?? '')) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  function request(owner: string, method: string, params: Record<string, unknown>, signal: AbortSignal,
    capability = true) {
    return fetch(endpoint, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-fixture-owner': owner, 'mcp-method': method, 'mcp-protocol-version': '2026-07-28',
        ...(typeof params.taskId === 'string' ? { 'mcp-name': params.taskId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'HTTP fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': capability
          ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {},
      } } }),
    });
  }
  const ackSchema = z.object({ method: z.literal('notifications/subscriptions/acknowledged'),
    params: z.object({ notifications: z.object({ taskIds: z.array(z.string()) }) }) });
  async function listen(owner: string) {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]);
    const response = await request(owner, 'subscriptions/listen', {
      notifications: { taskIds: ['alice', 'bob', 'unknown'] },
    }, signal);
    assert.equal(response.status, 200);
    const events = sseMessages(response);
    assert.deepEqual(ackSchema.parse((await events.next()).value).params.notifications.taskIds, [owner]);
    return { events, async close() {
      detached = Promise.withResolvers<void>();
      abort.abort();
      try { await events.return(undefined); } catch (error) {
        assert.equal((error as Error).name, 'AbortError');
      }
      await detached.promise;
    } };
  }

  await t.test('missing capability is rejected before subscription registration', async () => {
    const response = await request('alice', 'subscriptions/listen', {
      notifications: { taskIds: ['alice'] },
    }, AbortSignal.timeout(3000), false);
    assert.equal(response.status, 400);
    assert.equal(subscriptionCalls, 0);
    await response.body?.cancel();
  });

  await t.test('notifications and get share one authority, and each Principal sees only its filter', async () => {
    const alice = await listen('alice');
    const bob = await listen('bob');
    try {
      assert.equal(TaskStatusNotificationV2Schema.parse((await alice.events.next()).value).params.taskId, 'alice');
      assert.equal(TaskStatusNotificationV2Schema.parse((await bob.events.next()).value).params.taskId, 'bob');
      const record = records.get('alice')!;
      record.snapshot = { ...record.snapshot, status: 'completed', result: { content: [
        { type: 'text', text: 'SUBSCRIPTION_RESULT_OK' },
      ] } };
      for (const changed of record.listeners) changed();
      const notification = TaskStatusNotificationV2Schema.parse((await alice.events.next()).value);
      assert.equal(notification.params.status, 'completed');
      const response = await request('alice', 'tasks/get', { taskId: 'alice' }, AbortSignal.timeout(3000));
      const result = (await response.json() as { result: Record<string, unknown> }).result;
      const { _meta, ...snapshot } = notification.params;
      assert.deepEqual(result, { ...snapshot, resultType: 'complete' });
      assert.equal(records.get('bob')!.snapshot.status, 'working');
    } finally { await alice.close(); await bob.close(); }
    assert.equal(records.get('alice')!.listeners.size, 0);
    assert.equal(records.get('bob')!.listeners.size, 0);
  });

  await t.test('reconnect reads the completed result without task polling', async () => {
    const resumed = await listen('alice');
    try {
      const snapshot = TaskStatusNotificationV2Schema.parse((await resumed.events.next()).value).params;
      assert.equal(snapshot.status, 'completed');
    } finally { await resumed.close(); }
  });
});
