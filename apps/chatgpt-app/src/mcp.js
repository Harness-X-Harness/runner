import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  cancelEnvironmentWorkflow,
  dispatchEnvironmentWorkflow,
  getEnvironmentWorkflowRun,
} from "./github.js";
import { closeEnvironment, openEnvironment, readEnvironment } from "./environment.js";
import {
  ENVIRONMENT_WIDGET_MIME_TYPE,
  ENVIRONMENT_WIDGET_URI,
  environmentWidgetHtml,
} from "./environment-widget.js";
import {
  SESSION_WIDGET_MIME_TYPE,
  SESSION_WIDGET_URI,
  sessionWidgetHtml,
} from "./session-widget.js";
import { createSessionStreamCapability } from "./session-stream.js";
import { TOOL_CONTRACT } from "./tool-contract.js";
import {
  cancelAgentQueuedTurn,
  interruptAgentTurn,
  listAgentSessions,
  readAgentSession,
  respondToAgentSession,
  sendAgentTurn,
  startAgentSession,
  stopAgentSession,
  takeOverAgentSession,
} from "./session.js";

const SECURITY_SCHEMES = Object.freeze({
  start_session: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  list_sessions: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  read_session: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  send_turn: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  cancel_queued_turn: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  interrupt_turn: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  respond_to_session: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  take_over_session: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  stop_session: Object.freeze([{ type: "oauth2", scopes: ["sessions:manage"] }]),
  open_environment: Object.freeze([{ type: "oauth2", scopes: ["environments:manage"] }]),
  close_environment: Object.freeze([{ type: "oauth2", scopes: ["environments:manage"] }]),
});

const sessionPhaseSchema = z.enum([
  "preparing",
  "idle",
  "running",
  "waiting_for_user",
  "stopping",
  "terminal",
]);
const sessionActionSchema = z.enum([
  "send_turn",
  "interrupt_turn",
  "respond_to_session",
  "cancel_queued_turn",
  "take_over_session",
  "stop_session",
]);
const sessionSnapshotSchema = z.object({
  sessionId: z.string(),
  executor: z.enum(["codex", "grok"]),
  phase: sessionPhaseSchema,
  terminalReason: z.enum(["stopped", "environment_ended", "startup_failed", "driver_failed"]).optional(),
  channelState: z.enum(["connected", "disconnected"]),
  controller: z.object({ clientName: z.string(), currentGrant: z.boolean() }),
  allowedActions: z.array(sessionActionSchema),
  allowedTurnDeliveries: z.array(z.enum(["steer", "queue"])),
  workingDirectory: z.string(),
  activeTurnId: z.string().optional(),
  queuedTurns: z.array(z.object({ turnId: z.string(), createdAt: z.string() })),
  pendingRequests: z.array(z.object({ requestId: z.string(), kind: z.string() })),
  latestCursor: z.number(),
  environment: z.object({
    status: z.enum(["offline", "starting", "ready", "closing"]),
    entryUrl: z.string(),
    runUrl: z.string().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const sessionEventSchema = z.object({
  cursor: z.number(),
  sessionId: z.string(),
  type: z.enum(["status", "user_message", "agent_message_chunk", "activity", "request", "turn", "error"]),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const sessionReadSchema = z.object({
  session: sessionSnapshotSchema,
  events: z.array(sessionEventSchema),
  nextCursor: z.number(),
  hasMore: z.boolean(),
});

export function createServer(env, props) {
  const server = new McpServer(
    { name: "harness-x-harness", version: "1.0.0" },
    {
      instructions:
        "Use Agent Sessions for interactive coding: start_session includes the first task; use read_session and send_turn for later turns.",
    },
  );
  const controlPlaneOrigin = new URL(env.TASK_CONTROL_PLANE_URL).origin;
  server.registerResource(
    "environment-widget",
    ENVIRONMENT_WIDGET_URI,
    {
      description: "Control the current private development environment.",
      mimeType: ENVIRONMENT_WIDGET_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: ENVIRONMENT_WIDGET_URI,
          mimeType: ENVIRONMENT_WIDGET_MIME_TYPE,
          text: environmentWidgetHtml(controlPlaneOrigin),
          _meta: {
            ui: {
              prefersBorder: true,
              domain: controlPlaneOrigin,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription":
              "Shows the authoritative state and controls for the user's private development environment.",
            "openai/widgetCSP": {
              redirect_domains: [controlPlaneOrigin, "https://github.com"],
            },
          },
        },
      ],
    }),
  );
  server.registerResource(
    "session-widget",
    SESSION_WIDGET_URI,
    {
      description: "Show and control one private multi-turn Agent Session.",
      mimeType: SESSION_WIDGET_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: SESSION_WIDGET_URI,
          mimeType: SESSION_WIDGET_MIME_TYPE,
          text: sessionWidgetHtml(controlPlaneOrigin),
          _meta: {
            ui: {
              prefersBorder: true,
              domain: controlPlaneOrigin,
              csp: { connectDomains: [controlPlaneOrigin], resourceDomains: [] },
            },
            "openai/widgetDescription":
              "Shows one private Agent Session timeline and its exact interaction controls.",
            "openai/widgetCSP": {
              connect_domains: [controlPlaneOrigin],
              redirect_domains: [controlPlaneOrigin, "https://github.com"],
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "start_session",
    {
      title: "Start coding task",
      description:
        "Start one private long-lived Codex or Grok Session and immediately send its first task. Ask the user for the task before calling this tool.",
      inputSchema: z.object({
        executor: z.enum(["codex", "grok"]),
        workingDirectory: z.string().max(65_536).refine((value) => value.startsWith("/"), {
          message: "workingDirectory must be absolute",
        }).optional(),
        initialPrompt: z.string().min(1).max(65_536)
          .describe("The first task for the coding agent."),
      }),
      outputSchema: sessionSnapshotSchema,
      securitySchemes: SECURITY_SCHEMES.start_session,
      annotations: annotations("start_session"),
      _meta: sessionWidgetToolMeta("Starting session…", "Session started."),
    },
    async (input) => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.start_session[0].scopes);
      const session = await startAgentSession(
        env,
        requiredGitHubUserId(requestProps),
        requiredSessionController(requestProps),
        input,
        (workerEnv, request) => dispatchEnvironmentWorkflow(
          workerEnv,
          requiredGitHubAccessToken(requestProps),
          request,
        ),
        (workerEnv, runId) => cancelEnvironmentWorkflow(
          workerEnv,
          requiredGitHubAccessToken(requestProps),
          runId,
        ),
      );
      return result(
        session,
        `Session ${session.sessionId} is ${session.phase}.`,
        await sessionStreamMeta(env, requestProps, session.sessionId),
      );
    },
  );

  registerAppTool(
    server,
    "list_sessions",
    {
      title: "List coding sessions",
      description: "List the caller's private Session metadata without transcript events.",
      inputSchema: z.object({}),
      outputSchema: z.object({ sessions: z.array(sessionSnapshotSchema) }),
      securitySchemes: SECURITY_SCHEMES.list_sessions,
      annotations: annotations("list_sessions"),
    },
    async () => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.list_sessions[0].scopes);
      const sessions = await listAgentSessions(
        env,
        requiredGitHubUserId(requestProps),
        requiredSessionController(requestProps),
      );
      return result({ sessions }, `${sessions.length} Sessions found.`);
    },
  );

  registerAppTool(
    server,
    "read_session",
    {
      title: "Read coding session",
      description: "Read one current Session snapshot and ordered events after a cursor.",
      inputSchema: z.object({
        sessionId: z.string(),
        afterCursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: sessionReadSchema,
      securitySchemes: SECURITY_SCHEMES.read_session,
      annotations: annotations("read_session"),
      _meta: sessionWidgetToolMeta("Reading session…", "Session updated."),
    },
    async ({ sessionId, afterCursor, limit }) => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.read_session[0].scopes);
      await progressPendingSessionEnvironment(env, requestProps);
      const read = await readAgentSession(
        env,
        requiredGitHubUserId(requestProps),
        requiredSessionController(requestProps),
        sessionId,
        { afterCursor, limit },
      );
      return result(
        read,
        `Session ${sessionId} is ${read.session.phase}.`,
        await sessionStreamMeta(env, requestProps, sessionId),
      );
    },
  );

  registerAppTool(
    server,
    "send_turn",
    {
      title: "Send Session turn",
      description: "Send exact user text now, or explicitly queue it after the active turn.",
      inputSchema: z.object({
        sessionId: z.string(),
        text: z.string().min(1).max(65_536),
        delivery: z.enum(["steer", "queue"]).optional(),
      }),
      outputSchema: z.object({
        turnId: z.string(),
        delivery: z.enum(["steer", "queue"]),
        session: sessionSnapshotSchema,
      }),
      securitySchemes: SECURITY_SCHEMES.send_turn,
      annotations: annotations("send_turn"),
      _meta: sessionWidgetToolMeta("Sending turn…", "Turn sent."),
    },
    async ({ sessionId, text, delivery = "steer" }) => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.send_turn[0].scopes);
      const sent = await sendAgentTurn(
        env,
        requiredGitHubUserId(requestProps),
        requiredSessionController(requestProps),
        sessionId,
        text,
        delivery,
      );
      return result(
        sent,
        `${delivery === "queue" ? "Queued" : "Sent"} turn ${sent.turnId}.`,
        await sessionStreamMeta(env, requestProps, sessionId),
      );
    },
  );

  registerSessionMutationTool(server, env, props, "cancel_queued_turn", {
    title: "Cancel queued Session turn",
    description: "Cancel one exact queued turn before it starts.",
    inputSchema: z.object({ sessionId: z.string(), turnId: z.string() }),
  }, async (input, requestProps) => cancelAgentQueuedTurn(
    env,
    requiredGitHubUserId(requestProps),
    requiredSessionController(requestProps),
    input.sessionId,
    input.turnId,
  ));

  registerSessionMutationTool(server, env, props, "interrupt_turn", {
    title: "Interrupt active Session turn",
    description: "Interrupt one exact active turn without stopping the native Session.",
    inputSchema: z.object({ sessionId: z.string(), activeTurnId: z.string() }),
  }, async (input, requestProps) => interruptAgentTurn(
    env,
    requiredGitHubUserId(requestProps),
    requiredSessionController(requestProps),
    input.sessionId,
    input.activeTurnId,
  ));

  registerSessionMutationTool(server, env, props, "respond_to_session", {
    title: "Respond to Session request",
    description: "Answer one exact pending approval, question, or authorization request.",
    inputSchema: z.object({
      sessionId: z.string(),
      requestId: z.string(),
      choiceId: z.string().optional(),
      values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    }),
  }, async (input, requestProps) => {
    if ((input.choiceId === undefined) === (input.values === undefined)) {
      throw new Error("Exactly one Session response form is required");
    }
    return respondToAgentSession(
      env,
      requiredGitHubUserId(requestProps),
      requiredSessionController(requestProps),
      input.sessionId,
      input,
    );
  });

  registerSessionMutationTool(server, env, props, "take_over_session", {
    title: "Take control of coding session",
    description: "Atomically make this MCP Grant the controller for future Session writes.",
    inputSchema: z.object({ sessionId: z.string() }),
  }, async (input, requestProps) => takeOverAgentSession(
    env,
    requiredGitHubUserId(requestProps),
    requiredSessionController(requestProps),
    input.sessionId,
  ));

  registerSessionMutationTool(server, env, props, "stop_session", {
    title: "Stop coding session",
    description: "Stop one native Session without closing the shared private Environment.",
    inputSchema: z.object({ sessionId: z.string() }),
  }, async (input, requestProps) => stopAgentSession(
    env,
    requiredGitHubUserId(requestProps),
    requiredSessionController(requestProps),
    input.sessionId,
  ));

  registerAppTool(
    server,
    "open_environment",
    {
      title: "Open private development environment",
      description: "Use this when the user wants to open their temporary private development environment.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        status: z.enum(["starting", "ready", "closing"]),
        environmentUrl: z.string(),
        runUrl: z.string().optional(),
      }),
      securitySchemes: SECURITY_SCHEMES.open_environment,
      annotations: annotations("open_environment"),
      _meta: {
        ui: { resourceUri: ENVIRONMENT_WIDGET_URI },
        "openai/outputTemplate": ENVIRONMENT_WIDGET_URI,
        "openai/toolInvocation/invoking": "Opening environment…",
        "openai/toolInvocation/invoked": "Environment opened.",
      },
    },
    async () => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.open_environment[0].scopes);
      const environment = await openAuthorizedEnvironment(env, requestProps);
      return result(environment, `Environment is ${environment.status}.`);
    },
  );

  registerAppTool(
    server,
    "close_environment",
    {
      title: "Close private development environment",
      description: "Use this when the user explicitly wants to stop their temporary private development environment.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        status: z.enum(["closing", "offline"]),
        environmentUrl: z.string().optional(),
        runUrl: z.string().optional(),
      }),
      securitySchemes: SECURITY_SCHEMES.close_environment,
      annotations: annotations("close_environment"),
      _meta: {
        "openai/toolInvocation/invoking": "Closing environment…",
        "openai/toolInvocation/invoked": "Environment close requested.",
      },
    },
    async () => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.close_environment[0].scopes);
      const githubAccessToken = requiredGitHubAccessToken(requestProps);
      const environment = await closeEnvironment(
        env,
        requiredGitHubUserId(requestProps),
        (workerEnv, runId) =>
          cancelEnvironmentWorkflow(workerEnv, githubAccessToken, runId),
      );
      return result(environment, `Environment is ${environment.status}.`);
    },
  );

  return server;
}

export async function handleMcpRequest(request, env, props, ctx) {
  const toolsListRequest = request.method === "POST" && await isToolsListRequest(request);
  const handler = createMcpHandler(() => createServer(env, currentProps(props)), {
    route: "/mcp",
    authContext: { props: props ?? {} },
  });
  const response = await handler(request, env, ctx);
  return toolsListRequest
    ? addAppsSecuritySchemes(response)
    : response;
}

function currentProps(fallback) {
  return getMcpAuthContext()?.props ?? fallback ?? {};
}

function registerAppTool(server, name, config, handler) {
  const { securitySchemes, _meta, ...serverConfig } = config;
  server.registerTool(name, {
    ...serverConfig,
    _meta: { ..._meta, securitySchemes },
  }, handler);
}

function registerSessionMutationTool(server, env, fallbackProps, name, config, mutate) {
  registerAppTool(server, name, {
    ...config,
    outputSchema: sessionSnapshotSchema,
    securitySchemes: SECURITY_SCHEMES[name],
    annotations: annotations(name),
    _meta: sessionWidgetToolMeta("Updating session…", "Session updated."),
  }, async (input) => {
    const requestProps = currentProps(fallbackProps);
    requireScopes(requestProps, SECURITY_SCHEMES[name][0].scopes);
    const session = await mutate(input, requestProps);
    return result(
      session,
      `Session ${session.sessionId} is ${session.phase}.`,
      await sessionStreamMeta(env, requestProps, session.sessionId),
    );
  });
}

function sessionWidgetToolMeta(invoking, invoked) {
  return {
    ui: { resourceUri: SESSION_WIDGET_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": SESSION_WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

async function sessionStreamMeta(env, props, sessionId) {
  const capability = await createSessionStreamCapability(
    requiredGitHubUserId(props),
    sessionId,
    requiredSessionController(props).grantId,
    env.ENVIRONMENT_SESSION_SECRET,
  );
  return {
    sessionStream: {
      url: `${new URL(env.TASK_CONTROL_PLANE_URL).origin}/session-stream/${encodeURIComponent(sessionId)}`,
      token: capability.token,
      expiresAt: capability.expiresAt,
    },
  };
}

async function isToolsListRequest(request) {
  try {
    return (await request.clone().json())?.method === "tools/list";
  } catch {
    return false;
  }
}

async function addAppsSecuritySchemes(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json();
    return copyResponse(response, JSON.stringify(withAppsSecuritySchemes(body)));
  }
  if (contentType.includes("text/event-stream") && response.body) {
    const text = await new Response(response.body).text();
    const body = text.replace(/^data: (.+)$/gm, (line, data) => {
      try {
        return `data: ${JSON.stringify(withAppsSecuritySchemes(JSON.parse(data)))}`;
      } catch {
        return line;
      }
    });
    return copyResponse(response, body);
  }
  return response;
}

function copyResponse(response, body) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withAppsSecuritySchemes(body) {
  if (!body?.result?.tools) return body;
  return {
    ...body,
    result: {
      ...body.result,
      tools: body.result.tools.map((tool) => ({
        ...tool,
        securitySchemes: SECURITY_SCHEMES[tool.name],
      })),
    },
  };
}

/**
 * @param {Record<string, unknown>} structuredContent
 * @param {string} text
 * @param {Record<string, unknown>=} meta
 */
function result(structuredContent, text, meta = undefined) {
  return {
    structuredContent,
    content: [{ type: /** @type {const} */ ("text"), text }],
    ...(meta ? { _meta: meta } : {}),
  };
}

function annotations(name) {
  const contract = TOOL_CONTRACT.find((tool) => tool.name === name);
  if (!contract) throw new Error(`Unknown tool contract: ${name}`);
  const { name: _name, ...hints } = contract;
  return hints;
}

function requireScopes(props, required) {
  const granted = new Set(props?.oauthScopes ?? []);
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length > 0) throw new Error(`Missing OAuth scope: ${missing.join(", ")}`);
}

function requiredGitHubUserId(props) {
  if (props?.githubUserId === undefined) {
    throw new Error("GitHub authorization is required");
  }
  return String(props.githubUserId);
}

function requiredGitHubAccessToken(props) {
  if (
    props?.githubAuthorizationKind !== "github_app_scoped" ||
    typeof props?.environmentGithubAccessToken !== "string" ||
    props.environmentGithubAccessToken.length === 0
  ) {
    throw new Error("GitHub OAuth authorization is required");
  }
  return props.environmentGithubAccessToken;
}

function requiredSessionController(props) {
  if (
    typeof props?.mcpControllerGrantId !== "string" ||
    typeof props?.mcpClientName !== "string"
  ) {
    throw new Error("Reconnect to authorize Agent Sessions");
  }
  return {
    grantId: props.mcpControllerGrantId,
    clientName: props.mcpClientName,
  };
}

function openAuthorizedEnvironment(env, props) {
  const githubAccessToken = requiredGitHubAccessToken(props);
  return openEnvironment(
    env,
    requiredGitHubUserId(props),
    (workerEnv, request) =>
      dispatchEnvironmentWorkflow(workerEnv, githubAccessToken, request),
    undefined,
    (workerEnv, runId) =>
      cancelEnvironmentWorkflow(workerEnv, githubAccessToken, runId),
    (workerEnv, runId) =>
      getEnvironmentWorkflowRun(workerEnv, githubAccessToken, runId),
  );
}

async function progressPendingSessionEnvironment(env, props) {
  const environment = await readEnvironment(
    env,
    requiredGitHubUserId(props),
  );
  if (
    environment?.replacementGeneration &&
    new Set(["closing", "offline"]).has(environment.status)
  ) await openAuthorizedEnvironment(env, props);
}
