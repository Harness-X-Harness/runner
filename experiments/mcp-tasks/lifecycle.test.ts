// Controlled protocol fixture, not a production runtime or OAuth provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { StreamableHTTPClientTransport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import { CreateTaskResultV2Schema, DetailedTaskV2Schema, GetTaskResultV2Schema,
  TaskStatusNotificationV2Schema, type DetailedTaskV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { z } from 'zod';
import { serveTaskRequest, type TaskAuthority } from '../../apps/chatgpt-app/src/task-methods.ts';
import { observeTask } from '../../apps/chatgpt-app/src/task-observation.ts';
import { sseMessages } from './sse-messages.ts';

test('HTTP Task handle, input and cooperative cancellation with a reopened SQLite authority', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-task-protocol-'));
  const path = join(directory, 'tasks.sqlite');
  let database = new DatabaseSync(path);
  database.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, snapshot TEXT NOT NULL, cancel INTEGER NOT NULL DEFAULT 0)');
  t.after(async () => { database.close(); await rm(directory, { recursive: true }); });
  const listeners = new Map<string, Set<() => void>>();
  // Synthetic grant, deliberately not a production OAuth scope decision.
  const grants = new Set(['alice', 'bob']);
  const authorize = (owner: string) => {
    if (!grants.has(owner)) throw new Error('Fixture grant missing');
  };
  let detached = Promise.withResolvers<void>();
  const load = (owner: string, id: string): DetailedTaskV2 => {
    authorize(owner);
    const row = z.object({ snapshot: z.string() }).parse(database.prepare(
      'SELECT snapshot FROM tasks WHERE id = ? AND owner = ?',
    ).get(id, owner));
    return DetailedTaskV2Schema.parse(JSON.parse(row.snapshot));
  };
  const save = (snapshot: DetailedTaskV2) => {
    database.prepare('UPDATE tasks SET snapshot = ? WHERE id = ?')
      .run(JSON.stringify(DetailedTaskV2Schema.parse(snapshot)), snapshot.taskId);
    for (const changed of listeners.get(snapshot.taskId) ?? []) changed();
  };
  const terminal = (snapshot: DetailedTaskV2) => ['completed', 'failed', 'cancelled'].includes(snapshot.status);
  function authority(owner: string): TaskAuthority {
    return {
      async tools() { throw new Error('Unexpected discovery'); },
      async resources() { throw new Error('Unexpected discovery'); },
      async readResource() { throw new Error('Unexpected resource'); },
      async observeResources() { throw new Error('Unexpected resource subscription'); },
      async call(message) {
        authorize(owner);
        if (message.params.name === 'quick') return {
          resultType: 'complete', content: [{ type: 'text', text: 'QUICK_OK' }],
        };
        assert.equal(message.params.name, 'create');
        const now = new Date().toISOString();
        const snapshot: DetailedTaskV2 = { taskId: randomUUID(), status: 'working',
          createdAt: now, lastUpdatedAt: now, ttlMs: 60000 };
        // Autocommit completes before the handle can leave this handler.
        database.prepare('INSERT INTO tasks (id, owner, snapshot) VALUES (?, ?, ?)')
          .run(snapshot.taskId, owner, JSON.stringify(snapshot));
        return { ...load(owner, snapshot.taskId), resultType: 'task' };
      },
      async handle(message) {
        const snapshot = load(owner, message.params.taskId);
        if (message.method === 'tasks/get') return { ...snapshot, resultType: 'complete' };
        if (message.method === 'tasks/cancel' && !terminal(snapshot)) {
          database.prepare('UPDATE tasks SET cancel = 1 WHERE id = ?').run(snapshot.taskId);
        }
        if (message.method === 'tasks/update' && snapshot.status === 'input_required') {
          const answer = message.params.inputResponses.name;
          if (answer && 'action' in answer && answer.action === 'accept') save({
            ...snapshot, status: 'completed', result: {
              resultType: 'complete', content: [{ type: 'text', text: 'INPUT_ACCEPTED' }],
            },
          });
        }
        return { resultType: 'complete' };
      },
      async observe(ids, signal) {
        authorize(owner);
        return new Map(ids.filter(id => database.prepare(
          'SELECT id FROM tasks WHERE id = ? AND owner = ?',
        ).get(id, owner)).map(id => [id, observeTask({
          async read() { return load(owner, id); },
          subscribe(changed: () => void) {
            const set = listeners.get(id) ?? new Set<() => void>();
            listeners.set(id, set);
            set.add(changed);
            return () => {
              set.delete(changed);
              if (!set.size) listeners.delete(id);
              detached.resolve();
            };
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
  function request(method: string, params: Record<string, unknown>, capability = true, owner = 'alice',
    signal = AbortSignal.timeout(3000)) {
    const name = params.name ?? params.taskId;
    return fetch(endpoint, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-fixture-owner': owner, 'mcp-method': method, 'mcp-protocol-version': '2026-07-28',
        ...(typeof name === 'string' ? { 'mcp-name': name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'SQLite fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': capability
          ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {},
      } } }),
    });
  }
  async function call(method: string, params: Record<string, unknown>, capability = true, owner = 'alice') {
    const response = await request(method, params, capability, owner);
    return z.object({ result: z.unknown().optional(), error: z.object({ code: z.number() }).optional() })
      .parse(await response.json());
  }
  const create = async () => CreateTaskResultV2Schema.parse((await call('tools/call', { name: 'create' })).result);
  const get = async (taskId: string) => GetTaskResultV2Schema.parse((await call('tasks/get', { taskId })).result);
  async function listen(taskId: string) {
    const abort = new AbortController();
    const response = await request('subscriptions/listen', { notifications: { taskIds: [taskId] } },
      true, 'alice', AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]));
    const events = sseMessages(response);
    const ack = z.object({ method: z.literal('notifications/subscriptions/acknowledged'),
      params: z.object({ notifications: z.object({ taskIds: z.array(z.string()) }) }) });
    assert.deepEqual(ack.parse((await events.next()).value).params.notifications.taskIds, [taskId]);
    return {
      async next() { return TaskStatusNotificationV2Schema.parse((await events.next()).value).params; },
      nextMessage: () => events.next(),
      async close() {
        detached = Promise.withResolvers<void>();
        const hadObserver = listeners.size > 0;
        abort.abort();
        try { await events.return(undefined); } catch (error) {
          assert.equal((error as Error).name, 'AbortError');
        }
        if (hadObserver) await detached.promise;
        assert.equal(listeners.size, 0);
      },
    };
  }

  await t.test('missing capability creates nothing; fast result remains a normal result', async () => {
    assert.equal((await call('tools/call', { name: 'create' }, false)).error?.code, -32021);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 0);
    assert.deepEqual((await call('tools/call', { name: 'quick' })).result, {
      resultType: 'complete', content: [{ type: 'text', text: 'QUICK_OK' }],
    });
  });
  await t.test('returned handle reads immediately and survives reopening the database', async () => {
    const handle = await create();
    assert.equal((await get(handle.taskId)).status, 'working');
    database.close();
    database = new DatabaseSync(path);
    assert.equal((await get(handle.taskId)).status, 'working');
    const denied = await call('tasks/get', { taskId: handle.taskId }, true, 'bob');
    assert.ok(denied.error);
    assert.equal(denied.result, undefined);
  });
  await t.test('input is read and fulfilled through standard Task methods', async () => {
    const handle = await create();
    save({ ...load('alice', handle.taskId), status: 'input_required', inputRequests: {
      name: { method: 'elicitation/create', params: { mode: 'form', message: 'Fixture input',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } },
    } });
    assert.equal((await get(handle.taskId)).status, 'input_required');
    await call('tasks/update', { taskId: handle.taskId, inputResponses: { unknown: { action: 'accept' } } });
    assert.equal((await get(handle.taskId)).status, 'input_required');
    assert.deepEqual((await call('tasks/update', { taskId: handle.taskId,
      inputResponses: { name: { action: 'accept', content: { name: 'fixture' } } },
    })).result, { resultType: 'complete' });
    assert.equal((await get(handle.taskId)).status, 'completed');
  });
  await t.test('cancel acknowledgement is not a terminal Task', async () => {
    const handle = await create();
    assert.deepEqual((await call('tasks/cancel', { taskId: handle.taskId })).result, { resultType: 'complete' });
    assert.equal((await get(handle.taskId)).status, 'working');
    assert.equal(database.prepare('SELECT cancel FROM tasks WHERE id = ?').get(handle.taskId)?.cancel, 1);
    save({ ...load('alice', handle.taskId), status: 'cancelled' });
    assert.equal((await get(handle.taskId)).status, 'cancelled');
    await call('tasks/update', { taskId: handle.taskId, inputResponses: { name: { action: 'accept' } } });
    assert.equal((await get(handle.taskId)).status, 'cancelled');
  });
  await t.test('tool business errors and JSON-RPC failures have distinct Task outcomes', async () => {
    const business = await create();
    save({ ...load('alice', business.taskId), status: 'completed', result: {
      resultType: 'complete', isError: true, content: [{ type: 'text', text: 'Fixture business error' }],
    } });
    const businessResult = await get(business.taskId);
    assert.equal(businessResult.status, 'completed');
    assert.ok(businessResult.status === 'completed' && businessResult.result.isError === true);
    const failed = await create();
    save({ ...load('alice', failed.taskId), status: 'failed', error: { code: -32603, message: 'Fixture RPC failure' } });
    const rpcResult = await get(failed.taskId);
    assert.equal(rpcResult.status, 'failed');
    assert.ok(rpcResult.status === 'failed' && rpcResult.error.code === -32603);
  });
  await t.test('one durable Task goes from handle through input notification to result and reconnect', async () => {
    const handle = await create();
    const stream = await listen(handle.taskId);
    try {
      assert.equal((await stream.next()).status, 'working');
      save({ ...load('alice', handle.taskId), status: 'input_required', inputRequests: {
        name: { method: 'elicitation/create', params: { mode: 'form', message: 'Fixture input',
          requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } },
      } });
      assert.equal((await stream.next()).status, 'input_required');
      await call('tasks/update', { taskId: handle.taskId, inputResponses: { name: { action: 'accept' } } });
      const completed = await stream.next();
      assert.equal(completed.status, 'completed');
      const { _meta, ...snapshot } = completed;
      assert.deepEqual(await get(handle.taskId), { ...snapshot, resultType: 'complete' });
    } finally { await stream.close(); }
    database.close();
    database = new DatabaseSync(path);
    const resumed = await listen(handle.taskId);
    try { assert.equal((await resumed.next()).status, 'completed'); }
    finally { await resumed.close(); }
  });
  await t.test('cancel is observed only after its terminal state is committed', async () => {
    const handle = await create();
    const stream = await listen(handle.taskId);
    try {
      assert.equal((await stream.next()).status, 'working');
      await call('tasks/cancel', { taskId: handle.taskId });
      assert.equal(load('alice', handle.taskId).status, 'working');
      save({ ...load('alice', handle.taskId), status: 'cancelled' });
      assert.equal((await stream.next()).status, 'cancelled');
    } finally { await stream.close(); }
  });
  await t.test('revoked grant blocks reads, writes and subsequent subscription delivery', async () => {
    const handle = await create();
    const snapshot = load('alice', handle.taskId);
    const stream = await listen(handle.taskId);
    try {
      assert.equal((await stream.next()).status, 'working');
      grants.delete('alice');
      const before = database.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count;
      for (const [method, params] of [
        ['tools/call', { name: 'create' }],
        ['tasks/get', { taskId: handle.taskId }],
        ['tasks/cancel', { taskId: handle.taskId }],
        ['tasks/update', { taskId: handle.taskId, inputResponses: {} }],
      ] as const) {
        const denied = await call(method, params);
        assert.ok(denied.error);
        assert.equal(denied.result, undefined);
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, before);
      assert.equal(database.prepare('SELECT cancel FROM tasks WHERE id = ?').get(handle.taskId)?.cancel, 0);
      const stored = z.object({ snapshot: z.string() }).parse(
        database.prepare('SELECT snapshot FROM tasks WHERE id = ?').get(handle.taskId));
      assert.deepEqual(JSON.parse(stored.snapshot), snapshot);
      const rejected = await request('subscriptions/listen', { notifications: { taskIds: [handle.taskId] } });
      assert.equal(rejected.status, 403);
      save({ ...snapshot, status: 'completed', result: {
        resultType: 'complete', content: [{ type: 'text', text: 'MUST_NOT_BE_DELIVERED' }],
      } });
      const message = z.object({ jsonrpc: z.literal('2.0'), id: z.number(),
        error: z.object({ code: z.number(), message: z.string() }) }).strict()
        .parse((await stream.nextMessage()).value);
      assert.deepEqual(message.error, { code: -32603, message: 'Task request failed' });
      assert.equal((await stream.nextMessage()).done, true);
      assert.equal(listeners.size, 0);
    } finally {
      await stream.close();
      grants.add('alice');
    }
  });
  for (const outcome of ['complete', 'input', 'cancel'] as const) {
  await t.test(`official client transport observes ${outcome} without tasks/get`, async () => {
    const dispatched: string[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { 'x-fixture-owner': 'alice' } },
      fetch: async (url, init) => {
        dispatched.push(new Headers(init?.headers).get('mcp-method') ?? '');
        return fetch(url, init);
      },
    });
    // Native stream buffers notifications arriving before the test awaits them.
    let messages!: ReadableStreamDefaultController<JSONRPCMessage>;
    const stream = new ReadableStream<JSONRPCMessage>({ start(controller) { messages = controller; } });
    const reader = stream.getReader();
    transport.onmessage = message => messages.enqueue(message);
    transport.onerror = error => messages.error(error);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]);
    const send = (method: string, params: Record<string, unknown>) => transport.send({
      jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'official-transport-probe', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      } },
    }, { requestSignal: signal });
    await transport.start();
    try {
      await send('tools/call', { name: 'create' });
      const result = z.object({ result: CreateTaskResultV2Schema }).parse((await reader.read()).value).result;
      await send('subscriptions/listen', { notifications: { taskIds: [result.taskId] } });
      assert.equal(z.object({ method: z.string() }).parse((await reader.read()).value).method,
        'notifications/subscriptions/acknowledged');
      assert.equal(TaskStatusNotificationV2Schema.parse((await reader.read()).value).params.status, 'working');
      if (outcome === 'input') {
        save({ ...load('alice', result.taskId), status: 'input_required', inputRequests: {
          name: { method: 'elicitation/create', params: { mode: 'form', message: 'Fixture input',
            requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } },
        } });
        assert.equal(TaskStatusNotificationV2Schema.parse((await reader.read()).value).params.status, 'input_required');
        await send('tasks/update', { taskId: result.taskId, inputResponses: { name: { action: 'accept' } } });
        // Response and subscription run on separate HTTP requests; neither ordering is required.
        const pair = [(await reader.read()).value, (await reader.read()).value];
        const notification = pair.find(message => message && 'method' in message);
        const response = pair.find(message => message && 'result' in message);
        assert.deepEqual(z.object({ result: z.unknown() }).parse(response).result, { resultType: 'complete' });
        const completed = TaskStatusNotificationV2Schema.parse(notification).params;
        assert.equal(completed.status, 'completed');
        assert.ok(completed.status === 'completed');
        assert.deepEqual(completed.result.content, [{ type: 'text', text: 'INPUT_ACCEPTED' }]);
      } else if (outcome === 'cancel') {
        await send('tasks/cancel', { taskId: result.taskId });
        assert.deepEqual(z.object({ result: z.unknown() }).parse((await reader.read()).value).result,
          { resultType: 'complete' });
        assert.equal(load('alice', result.taskId).status, 'working');
        save({ ...load('alice', result.taskId), status: 'cancelled' });
        assert.equal(TaskStatusNotificationV2Schema.parse((await reader.read()).value).params.status, 'cancelled');
      } else {
        save({ ...load('alice', result.taskId), status: 'completed', result: {
          resultType: 'complete', content: [{ type: 'text', text: 'OFFICIAL_TRANSPORT_EVENT_OK' }],
        } });
        assert.equal(TaskStatusNotificationV2Schema.parse((await reader.read()).value).params.status, 'completed');
      }
      assert.deepEqual(dispatched, ['tools/call', 'subscriptions/listen',
        ...(outcome === 'input' ? ['tasks/update'] : outcome === 'cancel' ? ['tasks/cancel'] : [])]);
    } finally {
      detached = Promise.withResolvers<void>();
      const hadObserver = listeners.size > 0;
      abort.abort();
      await transport.close();
      if (hadObserver) await detached.promise;
      await reader.cancel();
      assert.equal(listeners.size, 0);
    }
  });
  }
});
