// Synthetic authorization fixture; not production OAuth or a resource backend.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { sseMessages } from './sse-messages.ts';

test('official resource handler keeps owner discovery, reads and subscriptions private', async t => {
  const records = new Map([
    ['alice', { uri: 'harness-probe://alice/output', text: 'ALICE_INITIAL' }],
    ['bob', { uri: 'harness-probe://bob/output', text: 'BOB_INITIAL' }],
  ]);
  const grants = new Map([...records.keys()].map(owner => [owner, new AbortController()]));
  // A bus per Principal in this bounded fixture prevents cross-owner events.
  // This is not a proposal to retain one SDK handler per production user.
  const handlers = new Map([...records].map(([owner, record]) => [owner, createMcpHandler(() => {
    const server = new McpServer({ name: 'resource-fixture', version: '1' }, {
      capabilities: { resources: { subscribe: true } },
    });
    server.registerResource('output', record.uri, {}, async () => ({
      contents: [{ uri: record.uri, text: record.text }],
    }));
    return server;
  }, { legacy: 'reject', keepAliveMs: 0 })]));
  t.after(async () => { await Promise.all([...handlers.values()].map(handler => handler.close())); });
  let id = 0;
  async function request(owner: string, method: string, params: Record<string, unknown> = {},
    signal = AbortSignal.timeout(3000)) {
    const record = records.get(owner);
    const handler = handlers.get(owner);
    const grant = grants.get(owner);
    if (!grant || grant.signal.aborted || !record || !handler) return new Response(null, { status: 403 });
    // Gate before SDK routing: its subscription filter is not an ACL.
    if (method === 'subscriptions/listen') {
      const filter = z.object({ notifications: z.object({ resourceSubscriptions: z.array(z.string()) }) })
        .parse(params);
      if (filter.notifications.resourceSubscriptions.some(uri => uri !== record.uri)) {
        return new Response(null, { status: 403 });
      }
    }
    return handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST', signal: AbortSignal.any([signal, grant.signal]),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-method': method, 'mcp-protocol-version': '2026-07-28',
        ...(typeof params.uri === 'string' ? { 'mcp-name': params.uri } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'resource-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    }));
  }
  const listSchema = z.object({ result: z.object({ resources: z.array(z.object({ uri: z.string() })) }) });
  const readSchema = z.object({ result: z.object({ contents: z.array(z.object({ text: z.string() })) }) });
  for (const [owner, record] of records) {
    const list = listSchema.parse(await (await request(owner, 'resources/list')).json());
    assert.deepEqual(list.result.resources.map(resource => resource.uri), [record.uri]);
    const other = records.get(owner === 'alice' ? 'bob' : 'alice')!;
    const denied = await (await request(owner, 'resources/read', { uri: other.uri })).json();
    assert.ok(z.object({ error: z.unknown() }).parse(denied).error);
    assert.equal((await request(owner, 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [record.uri, other.uri] },
    })).status, 403);
  }
  const record = records.get('alice')!;
  const abort = new AbortController();
  const events = sseMessages(await request('alice', 'subscriptions/listen', {
    notifications: { resourceSubscriptions: [record.uri] },
  }, AbortSignal.any([abort.signal, AbortSignal.timeout(3000)])));
  try {
    const ack = z.object({ method: z.literal('notifications/subscriptions/acknowledged') });
    ack.parse((await events.next()).value);
    record.text = 'RESOURCE_EVENT_READ_OK';
    handlers.get('alice')!.notify.resourceUpdated(record.uri);
    const update = z.object({ method: z.literal('notifications/resources/updated'),
      params: z.object({ uri: z.string() }) }).parse((await events.next()).value);
    assert.equal(update.params.uri, record.uri);
    const read = readSchema.parse(await (await request('alice', 'resources/read', { uri: update.params.uri })).json());
    assert.equal(read.result.contents[0]?.text, 'RESOURCE_EVENT_READ_OK');
    const pending = events.next();
    grants.get('alice')!.abort();
    // A later commit must not emit a URI notification on this revoked stream.
    record.text = 'AFTER_REVOCATION';
    handlers.get('alice')!.notify.resourceUpdated(record.uri);
    assert.equal((await pending).done, true);
    const bob = records.get('bob')!;
    assert.equal(readSchema.parse(await (await request('bob', 'resources/read', { uri: bob.uri })).json())
      .result.contents[0]?.text, bob.text);
    for (const [method, params] of [
      ['resources/list', {}], ['resources/read', { uri: record.uri }],
      ['subscriptions/listen', { notifications: { resourceSubscriptions: [record.uri] } }],
    ] as const) assert.equal((await request('alice', method, params)).status, 403);
  } finally {
    abort.abort();
    await events.return(undefined);
  }
});
