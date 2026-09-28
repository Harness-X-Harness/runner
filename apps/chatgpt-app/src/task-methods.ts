// Standard extension binding. The caller owns authentication and Task authority.
import {
  classifyInboundRequest, PerRequestHTTPServerTransport, ProtocolErrorCode, specTypeSchemas,
} from '@modelcontextprotocol/server';
import {
  GetTaskRequestV2Schema, UpdateTaskRequestV2Schema, CancelTaskRequestV2Schema,
  GetTaskResultV2Schema, UpdateTaskResultV2Schema, CancelTaskResultV2Schema,
  hasTaskClientCapabilityV2, RequestIdV2Schema,
  TaskSubscriptionNotificationsV2Schema, TaskStatusNotificationV2Schema,
  CreateTaskResultV2Schema, CallToolResultV2Schema,
  type DetailedTaskV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { z } from 'zod';
import { TaskError } from '../../../shared/task-errors.ts';

const requestSchema = z.discriminatedUnion('method', [
  GetTaskRequestV2Schema, UpdateTaskRequestV2Schema, CancelTaskRequestV2Schema,
]);
export type TaskMethodRequest = z.infer<typeof requestSchema>;
export type TaskMethodHandler = (request: TaskMethodRequest) => Promise<unknown>;
const callSchema = z.intersection(
  z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema }),
  z.unknown().transform((value, ctx) => {
    const result = specTypeSchemas.CallToolRequest['~standard'].validate(value);
    if (result.issues) {
      ctx.addIssue({ code: 'custom', message: 'Invalid tool call' });
      return z.NEVER;
    }
    return result.value;
  }),
);
export interface TaskAuthority {
  tools(): Promise<unknown>;
  resources(cursor?: string): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  call(request: z.infer<typeof callSchema>): Promise<unknown>;
  handle: TaskMethodHandler;
  // Return only requested, authorized IDs. Each source rechecks rights on read.
  observe(taskIds: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, AsyncIterable<DetailedTaskV2>>>;
  observeResources(uris: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, AsyncIterable<void>>>;
}
const listenSchema = z.intersection(z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema,
  method: z.literal('subscriptions/listen'),
  params: z.object({ notifications: TaskSubscriptionNotificationsV2Schema }),
}), z.unknown().transform((value, ctx) => {
  const result = specTypeSchemas.SubscriptionsListenRequest['~standard'].validate(value);
  if (result.issues) { ctx.addIssue({ code: 'custom', message: 'Invalid subscription request' }); return z.NEVER; }
  return result.value;
}));
const listSchema = z.intersection(z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema }),
  z.unknown().transform((value, ctx) => {
    const result = specTypeSchemas.ListToolsRequest['~standard'].validate(value);
    if (result.issues) { ctx.addIssue({ code: 'custom', message: 'Invalid tools list request' }); return z.NEVER; }
    return result.value;
  }));
const resourceListSchema = z.intersection(z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema }),
  z.unknown().transform((value, ctx) => {
    const result = specTypeSchemas.ListResourcesRequest['~standard'].validate(value);
    if (result.issues) { ctx.addIssue({ code: 'custom', message: 'Invalid resources list request' }); return z.NEVER; }
    return result.value;
  }));
const resourceReadSchema = z.intersection(z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema }),
  z.unknown().transform((value, ctx) => {
    const result = specTypeSchemas.ReadResourceRequest['~standard'].validate(value);
    if (result.issues) { ctx.addIssue({ code: 'custom', message: 'Invalid resource read request' }); return z.NEVER; }
    return result.value;
  }));
const discoverySchema = z.intersection(z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema }),
  z.unknown().transform((value, ctx) => {
    const result = specTypeSchemas.DiscoverRequest['~standard'].validate(value);
    if (result.issues) { ctx.addIssue({ code: 'custom', message: 'Invalid discovery request' }); return z.NEVER; }
    return result.value;
  }));
const pingSchema = z.intersection(z.object({ jsonrpc: z.literal('2.0'), id: RequestIdV2Schema }),
  z.unknown().transform((value, ctx) => {
    const result = specTypeSchemas.PingRequest['~standard'].validate(value);
    if (result.issues) { ctx.addIssue({ code: 'custom', message: 'Invalid ping request' }); return z.NEVER; }
    return result.value;
  }));
const extensionRequestSchema = z.union([requestSchema, listenSchema, callSchema, listSchema, resourceListSchema, resourceReadSchema, discoverySchema, pingSchema]);
const protocol = '2026-07-28';

// Mcp-Name uses UTF-8 Base64 only when its sentinel is present.
function decodeName(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!value.startsWith('=?base64?')) return value;
  if (!value.endsWith('?=')) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value.slice(9, -2)), char => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return undefined; }
}

export async function serveTaskRequest(request: Request, authority: TaskAuthority): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ jsonrpc: '2.0', id: null,
    error: { code: -32700, message: 'Invalid JSON' } }, { status: 400 }); }
  const id = z.object({ id: RequestIdV2Schema }).safeParse(body);
  const error = (status: number, code: number, message: string, data?: unknown) => Response.json({
    jsonrpc: '2.0', id: id.success ? id.data.id : null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }, { status });
  const route = classifyInboundRequest({
    httpMethod: request.method, body,
    protocolVersionHeader: request.headers.get('mcp-protocol-version') ?? undefined,
    mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
    mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
  });
  if (route.kind === 'reject') return error(route.httpStatus, route.code, route.message, route.data);
  if (route.kind !== 'modern' || route.classification.revision !== protocol) {
    return error(400, ProtocolErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', {
      supported: [protocol],
    });
  }
  if (route.messageKind !== 'request') return new Response(null, { status: 202 });
  if (!['server/discover', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'tasks/get', 'tasks/update', 'tasks/cancel', 'subscriptions/listen'].includes(route.message.method)) {
    return error(404, -32601, 'Unknown Task method');
  }
  const parsed = extensionRequestSchema.safeParse(route.message);
  if (!parsed.success) return error(400, -32602, 'Invalid Task request');
  if (request.headers.get('mcp-protocol-version') !== protocol
    || request.headers.get('mcp-method') !== parsed.data.method
    || (parsed.data.method !== 'server/discover' && parsed.data.method !== 'ping' && parsed.data.method !== 'subscriptions/listen' && parsed.data.method !== 'tools/list' && parsed.data.method !== 'resources/list'
      && decodeName(request.headers.get('mcp-name')) !== (parsed.data.method === 'tools/call'
        ? parsed.data.params.name : parsed.data.method === 'resources/read' ? parsed.data.params.uri : parsed.data.params.taskId))) {
    return error(400, -32020, 'MCP header mismatch');
  }
  const resourceOnly = parsed.data.method === 'subscriptions/listen' && !parsed.data.params.notifications.taskIds?.length;
  if (!resourceOnly && !['server/discover', 'ping', 'tools/list', 'resources/list', 'resources/read'].includes(parsed.data.method) && !hasTaskClientCapabilityV2(route.message.params)) {
    return error(400, ProtocolErrorCode.MissingRequiredClientCapability, 'Tasks capability required', {
      requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });
  }
  const input = parsed.data;
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal });
  if (request.signal.aborted) controller.abort();
  let sources: ReadonlyMap<string, AsyncIterable<DetailedTaskV2>> = new Map();
  let resources: ReadonlyMap<string, AsyncIterable<void>> = new Map();
  if (input.method === 'subscriptions/listen') {
    const ids = [...new Set(input.params.notifications.taskIds ?? [])];
    const uris = [...new Set(input.params.notifications.resourceSubscriptions ?? [])];
    try {
      [sources, resources] = await Promise.all([
        ids.length ? authority.observe(ids, controller.signal) : Promise.resolve(new Map<string, AsyncIterable<DetailedTaskV2>>()),
        uris.length ? authority.observeResources(uris, controller.signal) : Promise.resolve(new Map<string, AsyncIterable<void>>()),
      ]);
      if ([...sources.keys()].some(id => !ids.includes(id))) throw new Error('Invalid authority filter');
      if ([...resources.keys()].some(uri => !uris.includes(uri))) throw new Error('Invalid resource filter');
    } catch { controller.abort(); return error(403, -32602, 'Task subscription unavailable'); }
  }
  const transport = new PerRequestHTTPServerTransport({ classification: route.classification,
    responseMode: input.method === 'subscriptions/listen' ? 'sse' : 'auto' });
  transport.onclose = () => controller.abort();
  transport.onmessage = () => {
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      if (input.method === 'server/discover') {
        const result = specTypeSchemas.DiscoverResult['~standard'].validate({ resultType: 'complete',
          ttlMs: 0, cacheScope: 'private',
          supportedVersions: [protocol], capabilities: { tools: {}, resources: { subscribe: true },
            extensions: { 'io.modelcontextprotocol/tasks': {} } },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'harness-x-harness', version: '2.0.0' } },
        });
        if (result.issues) throw new Error('Invalid discovery result');
        await transport.send({ jsonrpc: '2.0', id: input.id, result: result.value });
        return;
      }
      if (input.method === 'ping') {
        await transport.send({ jsonrpc: '2.0', id: input.id, result: { resultType: 'complete' } });
        return;
      }
      if (input.method === 'tools/list') {
        const result = specTypeSchemas.ListToolsResult['~standard'].validate(await authority.tools());
        if (result.issues) throw new Error('Invalid tool catalog');
        await transport.send({ jsonrpc: '2.0', id: input.id, result: result.value });
        return;
      }
      if (input.method === 'resources/list') {
        const result = specTypeSchemas.ListResourcesResult['~standard'].validate(await authority.resources(input.params?.cursor));
        if (result.issues) throw new Error('Invalid resource catalog');
        await transport.send({ jsonrpc: '2.0', id: input.id, result: result.value });
        return;
      }
      if (input.method === 'resources/read') {
        const result = specTypeSchemas.ReadResourceResult['~standard'].validate(await authority.readResource(input.params.uri));
        if (result.issues) throw new Error('Invalid resource result');
        await transport.send({ jsonrpc: '2.0', id: input.id, result: result.value });
        return;
      }
      if (input.method === 'tools/call') {
        const result = z.union([CreateTaskResultV2Schema, CallToolResultV2Schema]).parse(await authority.call(input));
        await transport.send({ jsonrpc: '2.0', id: input.id, result });
        return;
      }
      if (input.method === 'subscriptions/listen') {
        const meta = { 'io.modelcontextprotocol/subscriptionId': input.id };
        await transport.send({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
          params: { _meta: meta, notifications: {
            ...(input.params.notifications.taskIds ? { taskIds: [...sources.keys()] } : {}),
            ...(input.params.notifications.resourceSubscriptions ? { resourceSubscriptions: [...resources.keys()] } : {}),
          } },
        }, { relatedRequestId: input.id });
        await Promise.all([...resources].map(async ([uri, source]) => {
          for await (const _changed of source) {
            const notification = specTypeSchemas.ResourceUpdatedNotification['~standard'].validate({
              method: 'notifications/resources/updated', params: { uri, _meta: meta },
            });
            if (notification.issues) throw new Error('Invalid resource notification');
            await transport.send({ jsonrpc: '2.0', ...notification.value }, { relatedRequestId: input.id });
          }
        }).concat([...sources].map(async ([taskId, source]) => {
          for await (const snapshot of source) {
            if (snapshot.taskId !== taskId) throw new Error('Invalid authority snapshot');
            await transport.send(TaskStatusNotificationV2Schema.parse({
              jsonrpc: '2.0', method: 'notifications/tasks', params: { ...snapshot, _meta: meta },
            }), { relatedRequestId: input.id });
          }
        })));
        if (!controller.signal.aborted) await transport.send({ jsonrpc: '2.0', id: input.id,
          result: { resultType: 'complete', _meta: meta } });
        return;
      }
      const raw = await authority.handle(input);
      const schema = input.method === 'tasks/get' ? GetTaskResultV2Schema
        : input.method === 'tasks/update' ? UpdateTaskResultV2Schema : CancelTaskResultV2Schema;
      await transport.send({ jsonrpc: '2.0', id: input.id, result: schema.parse(raw) });
    }).catch(async (failure: unknown) => {
      controller.abort();
      // Never expose handler exceptions or storage/provider details.
      const notFound = failure instanceof TaskError && failure.code === 'TASK_NOT_FOUND';
      const resourceMissing = failure instanceof TaskError && failure.code === 'RESOURCE_NOT_FOUND';
      await transport.send({ jsonrpc: '2.0', id: input.id,
        error: notFound ? { code: -32602, message: 'Task not found or no longer available' }
          : resourceMissing ? { code: -32602, message: 'Resource not found or no longer available' }
          : { code: -32603, message: 'Task request failed' } });
    });
  };
  await transport.start();
  return transport.handleMessage(route.message, { request });
}
