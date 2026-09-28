// Public transport seam only: no Task store, HTTP routing, or host acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerRequestHTTPServerTransport } from '@modelcontextprotocol/server';
import {
  TaskStatusNotificationV2Schema,
  TaskSubscriptionAcknowledgedNotificationsV2Schema,
} from '@modelcontextprotocol/ext-tasks/core/v2';

test('subscription acknowledgement and Task notifications precede the closing result', async () => {
  const transport = new PerRequestHTTPServerTransport({
    classification: { era: 'modern', revision: '2026-07-28' },
    responseMode: 'sse', keepAliveMs: 0,
  });
  transport.onmessage = () => {};
  await transport.start();
  const requestId = 1;
  const meta = { 'io.modelcontextprotocol/subscriptionId': requestId };
  try {
    const response = await transport.handleMessage({
      jsonrpc: '2.0', id: requestId, method: 'subscriptions/listen',
      params: { notifications: { taskIds: ['probe-task'] } },
    }, { request: new Request('https://probe.invalid/mcp', { signal: AbortSignal.timeout(2000) }) });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const readFrame = async (): Promise<unknown> => {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      const text = new TextDecoder().decode(chunk.value);
      assert.match(text, /^event: message\ndata: /);
      return JSON.parse(text.slice('event: message\ndata: '.length).trim());
    };
    const acknowledgement = {
      jsonrpc: '2.0' as const, method: 'notifications/subscriptions/acknowledged',
      params: { _meta: meta, notifications: TaskSubscriptionAcknowledgedNotificationsV2Schema.parse({
        taskIds: ['probe-task'],
      }) },
    };
    await transport.send(acknowledgement, { relatedRequestId: requestId });
    assert.deepEqual(await readFrame(), acknowledgement);

    const timestamp = new Date().toISOString();
    const notification = TaskStatusNotificationV2Schema.parse({
      jsonrpc: '2.0', method: 'notifications/tasks', params: {
        taskId: 'probe-task', status: 'completed', createdAt: timestamp,
        lastUpdatedAt: timestamp, ttlMs: 60000,
        result: { content: [{ type: 'text', text: 'TRANSPORT_OK' }] }, _meta: meta,
      },
    });
    await transport.send(notification, { relatedRequestId: requestId });
    assert.deepEqual(TaskStatusNotificationV2Schema.parse(await readFrame()), notification);

    const end = { jsonrpc: '2.0' as const, id: requestId,
      result: { resultType: 'complete', _meta: meta } };
    await transport.send(end);
    assert.deepEqual(await readFrame(), end);
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
  } finally {
    await transport.close();
  }
});

test('request abort closes the subscription without inventing a terminal result', async () => {
  const transport = new PerRequestHTTPServerTransport({
    classification: { era: 'modern', revision: '2026-07-28' },
    responseMode: 'sse', keepAliveMs: 0,
  });
  transport.onmessage = () => {};
  const controller = new AbortController();
  await transport.start();
  try {
    const response = await transport.handleMessage({
      jsonrpc: '2.0', id: 2, method: 'subscriptions/listen',
      params: { notifications: { taskIds: ['probe-task'] } },
    }, { request: new Request('https://probe.invalid/mcp', { signal: controller.signal }) });
    controller.abort();
    assert.equal(await response.text(), '');
  } finally {
    await transport.close();
  }
});
