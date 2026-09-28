/// <reference path="../../apps/chatgpt-app/node_modules/@cloudflare/workers-types/index.d.ts" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveTaskRequest, type TaskAuthority } from '../../apps/chatgpt-app/src/task-methods.ts';

// Real transport, silent synthetic authority. This proves idle framing, not production connectivity.
test('silent subscriptions retain the SDK SSE heartbeat without reading state again', { timeout: 22000 }, async () => {
  const abort = new AbortController();
  let observations = 0;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected authority read'); };
  const authority: TaskAuthority = {
    tools: unexpected, resources: unexpected, readResource: unexpected,
    call: unexpected, handle: unexpected, observe: unexpected,
    async observeResources(_uris, signal) {
      observations++;
      return new Map([['harness://fixture', (async function* () {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      })()]]);
    },
  };
  const response = await serveTaskRequest(new Request('http://localhost/mcp', {
    method: 'POST', signal: abort.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-method': 'subscriptions/listen', 'mcp-protocol-version': '2026-07-28' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {
      notifications: { resourceSubscriptions: ['harness://fixture'] }, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'idle-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } }),
  }), authority);
  const reader = response.body!.getReader();
  const deadline = setTimeout(() => abort.abort(), 20000);
  let heartbeat = false;
  try {
    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    while (!heartbeat) {
      const chunk = await reader.read();
      if (chunk.done) break;
      heartbeat = decoder.decode(chunk.value).includes(': keepalive');
    }
    assert.ok(heartbeat, 'silent subscription must send an SDK keepalive before the idle deadline');
    assert.equal(observations, 1, 'heartbeats must not poll application state');
  } finally {
    clearTimeout(deadline);
    abort.abort();
    await reader.cancel();
  }
});
