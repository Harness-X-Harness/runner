// Official requester diagnostic with a synthetic port, not a host acceptance test.
import { withTasks, createTaskSessionEndpointId, toolDeclaration,
  type ConnectedMcpSessionPort } from '@modelcontextprotocol/ext-tasks/client';
import { z } from 'zod';

const methods: string[] = [];
const now = new Date().toISOString();
const base = { taskId: 'probe-task', createdAt: now, lastUpdatedAt: now, ttlMs: 60000 };
const port: ConnectedMcpSessionPort = {
  endpointId: await createTaskSessionEndpointId('probe', { url: 'https://fixture.invalid/mcp' }),
  taskCapabilities: { generation: 'v2', capabilities: {} }, invalidated: false,
  async dispatch(request) {
    const { method } = z.object({ method: z.string() }).parse(request);
    methods.push(method);
    if (method === 'tools/call') return { kind: 'result', result: {
      ...base, status: 'working', resultType: 'task',
    } };
    if (method === 'tasks/get') return { kind: 'result', result: {
      ...base, status: 'completed', resultType: 'complete', result: {
        resultType: 'complete', content: [{ type: 'text', text: 'FIXTURE_OK' }],
      },
    } };
    throw new Error('Unexpected method');
  },
  onServerRequest() { return () => {}; },
  onNotification() { return () => {}; },
  onInvalidated() { return () => {}; },
};
const declaration = toolDeclaration({
  name: 'fixture', inputSchema: { type: 'object' }, taskSupport: 'required',
});
const session = withTasks(port, { signal: AbortSignal.timeout(1500),
  tools: { currentTool: name => name === declaration.name ? declaration : undefined },
});
try {
  const execution = await session.callTool('fixture');
  const outcome = await execution.result();
  console.log(JSON.stringify({
    scope: 'official-client synthetic-port diagnostic', methods,
    status: outcome.status, noNotificationSent: true, productionAcceptance: false,
  }, null, 2));
  // This synthetic port cannot establish real-client or event-only acceptance.
  process.exitCode = 2;
} finally { await session.close(); }
