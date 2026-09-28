// Public SDK integration probe, not a production Task implementation.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { CreateTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { z } from 'zod';
import { sseMessages } from '../../tests/helpers/sse-messages.ts';

const protocol = '2026-07-28';
const uri = 'harness-probe://output';
const timestamp = new Date().toISOString();
const task = { taskId: 'probe-task', status: 'working', createdAt: timestamp,
  lastUpdatedAt: timestamp, ttlMs: 60000 };
const taskResult = CreateTaskResultV2Schema.parse({ resultType: 'task', ...task });
let output = 'initial';
let id = 0;
const invoked = new Set();
const report: Record<string, unknown> = {};
const methods = ['tasks/get', 'tasks/update', 'tasks/cancel'] as const;
// Validate only the response fields this diagnostic consumes. Unknown fields stay unknown.
const envelope = z.object({
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  params: z.object({
    uri: z.string().optional(),
    notifications: z.object({ taskIds: z.array(z.string()).optional() }).passthrough().optional(),
  }).passthrough().optional(),
});
const contentResult = z.object({ content: z.array(z.object({ text: z.string() })) });
const resourceList = z.object({ resources: z.array(z.object({ uri: z.string() })) });
const resourceRead = z.object({ contents: z.array(z.object({ text: z.string() })) });
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'harness-probe', version: '1' }, {
    capabilities: { resources: { subscribe: true },
      extensions: { 'io.modelcontextprotocol/tasks': {} } },
  });
  server.registerTool('quick', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'PROTOCOL_OK' }],
  }));
  // The public tool callback type does not include extension Task results.
  // Deliberately probe runtime acceptance too; fail compilation if this type gap disappears.
  // @ts-expect-error Task extension result is outside the SDK callback result union.
  server.registerTool('deferred', { inputSchema: z.object({}) }, async () => taskResult);
  server.registerResource('output', uri, {}, async () => ({
    contents: [{ uri, text: output }],
  }));
  // Use only the SDK's public custom-method registration, never private maps.
  for (const method of methods) {
    server.server.setRequestHandler(method, {
      params: z.object({ taskId: z.string() }), result: z.looseObject({}),
    }, async () => {
      invoked.add(method);
      return method === 'tasks/get' ? task : {};
    });
  }
  return server;
}, { legacy: 'reject', keepAliveMs: 0 });

// Real loopback HTTP through the official Node transport adapter.
const http = createServer(toNodeHandler(handler));

function request(method: string, params: Record<string, unknown> = {}, signal = AbortSignal.timeout(5000)) {
  const name = params.name ?? params.uri ?? params.taskId;
  return fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-method': method, 'mcp-protocol-version': protocol,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': protocol,
      'io.modelcontextprotocol/clientInfo': { name: 'harness-loopback-probe', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    } } }),
  });
}

async function* events(response: Response) {
  for await (const message of sseMessages(response)) yield envelope.parse(message);
}

try {
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const quick = envelope.parse(await (await request('tools/call', { name: 'quick', arguments: {} })).json());
  assert.equal(contentResult.parse(quick.result).content[0].text, 'PROTOCOL_OK');
  report.immediateResult = 'passed';

  const list = envelope.parse(await (await request('resources/list')).json());
  assert.ok(resourceList.parse(list.result).resources.some(resource => resource.uri === uri));
  report.resourceDiscovery = 'passed';
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]);
  const stream = events(await request('subscriptions/listen', {
    notifications: { resourceSubscriptions: [uri] },
  }, signal));
  try {
    const ack = (await stream.next()).value;
    assert.ok(ack);
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
    report.resourceSubscription = ack;
    output = 'RESOURCE_EVENT_OK';
    handler.notify.resourceUpdated(uri);
    const update = (await stream.next()).value;
    assert.ok(update);
    assert.equal(update.method, 'notifications/resources/updated');
    assert.equal(update.params?.uri, uri);
    const read = envelope.parse(await (await request('resources/read', { uri })).json());
    assert.equal(resourceRead.parse(read.result).contents[0].text, output);
    report.resourceEventRead = 'passed';
  } finally {
    await stream.return();
    abort.abort();
  }

  const deferred = envelope.parse(await (await request('tools/call', { name: 'deferred', arguments: {} })).json());
  const taskHandle = { validV2Input: true,
    accepted: CreateTaskResultV2Schema.safeParse(deferred.result).success,
    error: deferred.error };
  report.taskHandle = taskHandle;
  for (const method of methods) {
    const response = await request(method, { taskId: task.taskId });
    const body = envelope.parse(await response.json());
    report[method] = { httpStatus: response.status, handlerInvoked: invoked.has(method),
      error: body.error };
  }
  // A core-only subscription must not masquerade as Tasks subscription support.
  const taskAbort = new AbortController();
  const taskStream = events(await request('subscriptions/listen', {
    notifications: { taskIds: [task.taskId] },
  }, AbortSignal.any([taskAbort.signal, AbortSignal.timeout(5000)])));
  let taskSubscription: z.infer<typeof envelope> | undefined;
  try {
    taskSubscription = (await taskStream.next()).value || undefined;
    report.taskSubscription = taskSubscription;
  } finally {
    await taskStream.return();
    taskAbort.abort();
  }
  report.status = !taskHandle.accepted ||
    methods.some(method => !invoked.has(method)) ||
    !taskSubscription?.params?.notifications?.taskIds?.includes(task.taskId)
    ? 'blocked' : 'incomplete';
  console.log(JSON.stringify(report, null, 2));
  // Even accepted routing is not evidence of durable Tasks or lifecycle behavior.
  process.exitCode = report.status === 'blocked' ? 1 : 2;
} catch (error) {
  console.log(JSON.stringify(report, null, 2));
  throw error;
} finally {
  await handler.close();
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
}
