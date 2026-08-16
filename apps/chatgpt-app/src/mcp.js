import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { cancelWorkflow, dispatchWorkflow } from "./github.js";
import {
  createInstallationRequest,
  resolveRepositoryAccess,
} from "./repository-authorization.js";
import { EXECUTORS, MODES, TASK_STATUSES, publicTask, validateSubmitInput } from "./task.js";
import {
  commitTaskDispatch,
  readTask as readTaskFromStore,
  updateTask,
  writeTask,
} from "./task-store.js";
import { TOOL_CONTRACT } from "./tool-contract.js";
import { OAUTH_SCOPES, requiredSubmitScopes } from "./oauth-scopes.js";

const SECURITY_SCHEMES = Object.freeze({
  submit_task: Object.freeze([{ type: "oauth2", scopes: requiredSubmitScopes("analyze") }]),
  get_task: Object.freeze([{ type: "oauth2", scopes: ["tasks:read"] }]),
  cancel_task: Object.freeze([{ type: "oauth2", scopes: ["tasks:cancel"] }]),
  get_task_result: Object.freeze([{ type: "oauth2", scopes: ["tasks:read"] }]),
});

const statusSchema = z.enum(TASK_STATUSES);
const taskOutputSchema = z.object({
  id: z.string(),
  repo: z.string(),
  ref: z.string(),
  executor: z.enum(EXECUTORS),
  mode: z.enum(MODES),
  status: statusSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  runId: z.string().optional(),
  authorizationUrl: z.string().optional(),
  requiredPermissions: z.array(z.string()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});

export function createServer(env, props) {
  const server = new McpServer(
    { name: "harness-x-harness-task-runner", version: "1.0.0" },
    {
      instructions:
        "Use submit_task to start a task, then get_task to follow progress. Use get_task_result only after completion.",
    },
  );

  registerAppTool(
    server,
    "submit_task",
    {
      title: "Submit code task",
      description: "Use this when the user wants an authorized repository task executed by a selected coding agent.",
      inputSchema: z.object({
        repo: z.string().describe("GitHub repository in owner/repository form."),
        prompt: z.string().describe("The coding task instructions; they are retained privately by the control plane."),
        executor: z.enum(EXECUTORS).describe("Coding executor to run."),
        ref: z.string().optional().describe("Branch, tag, or commit; defaults to main."),
        mode: z.enum(MODES).optional().describe("analyze, edit, or pull_request; defaults to analyze."),
      }),
      outputSchema: z.object({
        taskId: z.string(),
        status: statusSchema,
        repo: z.string(),
        executor: z.enum(EXECUTORS),
        createdAt: z.string(),
        authorizationUrl: z.string().optional(),
        requiredPermissions: z.array(z.string()).optional(),
      }),
      securitySchemes: SECURITY_SCHEMES.submit_task,
      annotations: annotations("submit_task"),
    },
    async (input) => {
      const requestProps = currentProps(props);
      const taskInput = validateSubmitInput(input);
      requireScopes(requestProps, requiredSubmitScopes(taskInput.mode));
      const baseTask = {
        id: `task_${crypto.randomUUID()}`,
        ...taskInput,
        ownerId: String(requestProps?.githubUserId ?? requestProps?.userId ?? "unknown"),
        runnerRepository: env.GITHUB_RUNNER_REPOSITORY,
        createdAt: new Date().toISOString(),
      };
      const access = await resolveRepositoryAccess(env, requestProps, baseTask);
      if (access.kind === "installation_required") {
        const authorization = await createInstallationRequest(env, baseTask);
        const task = {
          ...baseTask,
          ...authorization,
          requiredPermissions: access.requiredPermissions,
          status: "awaiting_installation",
        };
        await writeTask(env, task);
        return result({
          taskId: task.id,
          status: task.status,
          repo: task.repo,
          executor: task.executor,
          createdAt: task.createdAt,
          authorizationUrl: task.authorizationUrl,
          requiredPermissions: task.requiredPermissions,
        }, `Task ${task.id} needs repository authorization.`);
      }

      const task = {
        ...baseTask,
        repositoryAccess: access.repositoryAccess,
        status: "dispatching",
      };
      await writeTask(env, task);
      try {
        await dispatchWorkflow(env, task);
        const queued = await commitTaskDispatch(env, task.id);
        return result({
          taskId: queued.id,
          status: queued.status,
          repo: queued.repo,
          executor: queued.executor,
          createdAt: queued.createdAt,
        }, `Queued ${queued.executor} task ${queued.id}.`);
      } catch (error) {
        await updateTask(env, task.id, {
          status: "failed",
          error: "workflow dispatch failed",
        }).catch(() => undefined);
        throw error;
      }
    },
  );

  registerAppTool(
    server,
    "get_task",
    {
      title: "Get task status",
      description: "Use this when the user wants the current status of a previously submitted code task.",
      inputSchema: z.object({ taskId: z.string() }),
      outputSchema: taskOutputSchema,
      securitySchemes: SECURITY_SCHEMES.get_task,
      annotations: annotations("get_task"),
    },
    async ({ taskId }) => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.get_task[0].scopes);
      const task = await readOwnedTask(env, taskId, requestProps);
      return result(publicTask(task), `Task ${task.id} is ${task.status}.`);
    },
  );

  registerAppTool(
    server,
    "cancel_task",
    {
      title: "Cancel code task",
      description: "Use this when the user explicitly wants a queued or running code task cancelled.",
      inputSchema: z.object({ taskId: z.string() }),
      outputSchema: taskOutputSchema,
      securitySchemes: SECURITY_SCHEMES.cancel_task,
      annotations: annotations("cancel_task"),
    },
    async ({ taskId }) => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.cancel_task[0].scopes);
      const task = await readOwnedTask(env, taskId, requestProps);
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        return result(publicTask(task), `Task ${task.id} is already ${task.status}.`);
      }
      await cancelWorkflow(env, task);
      const status = task.runId ? "cancel_requested" : "cancelled";
      const updated = await updateTask(env, taskId, { status });
      return result(publicTask(updated), task.runId
        ? `Cancellation requested for task ${task.id}.`
        : `Task ${task.id} was cancelled before the runner started.`);
    },
  );

  registerAppTool(
    server,
    "get_task_result",
    {
      title: "Get task result",
      description: "Use this when a code task has completed and the user wants its summary, commit, or pull request.",
      inputSchema: z.object({ taskId: z.string() }),
      outputSchema: taskOutputSchema,
      securitySchemes: SECURITY_SCHEMES.get_task_result,
      annotations: annotations("get_task_result"),
    },
    async ({ taskId }) => {
      const requestProps = currentProps(props);
      requireScopes(requestProps, SECURITY_SCHEMES.get_task_result[0].scopes);
      const task = await readOwnedTask(env, taskId, requestProps);
      return result(publicTask(task), `Task ${task.id} is ${task.status}.`);
    },
  );

  return server;
}

export async function handleMcpRequest(request, env, props, ctx) {
  const toolsListRequest = request.method === "POST" && await isToolsListRequest(request);
  const stepUp = request.method === "POST"
    ? await requiredStepUp(request, currentProps(props))
    : undefined;
  if (stepUp) return insufficientScopeResponse(request, stepUp.id, stepUp.scopes);
  const handler = createMcpHandler(() => createServer(env, currentProps(props)), {
    route: "/mcp",
    authContext: { props: props ?? {} },
  });
  const response = await handler(request, env, ctx);
  return toolsListRequest
    ? addAppsSecuritySchemes(response)
    : response;
}

async function requiredStepUp(request, props) {
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return undefined;
  }
  if (body?.method !== "tools/call" || body?.params?.name !== "submit_task") {
    return undefined;
  }
  const mode = body.params.arguments?.mode ?? "analyze";
  if (!MODES.includes(mode)) return undefined;
  const required = requiredSubmitScopes(mode);
  const granted = new Set(props?.oauthScopes ?? []);
  if (required.every((scope) => granted.has(scope))) return undefined;
  return {
    id: body.id,
    scopes: OAUTH_SCOPES.filter(
      (scope) => granted.has(scope) || required.includes(scope),
    ),
  };
}

function insufficientScopeResponse(request, id, scopes) {
  const resourceMetadata = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    request.url,
  );
  const authenticate = [
    'Bearer error="insufficient_scope"',
    'error_description="Additional authorization is required"',
    `scope="${scopes.join(" ")}"`,
    `resource_metadata="${resourceMetadata}"`,
  ].join(", ");
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{
        type: "text",
        text: "Additional authorization is required.",
      }],
      _meta: { "mcp/www_authenticate": [authenticate] },
      isError: true,
    },
  }, { headers: { "cache-control": "no-store" } });
}

function currentProps(fallback) {
  return getMcpAuthContext()?.props ?? fallback ?? {};
}

function registerAppTool(server, name, config, handler) {
  const { securitySchemes, ...serverConfig } = config;
  server.registerTool(name, {
    ...serverConfig,
    _meta: { securitySchemes },
  }, handler);
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

async function readOwnedTask(env, taskId, props) {
  const task = await readTaskFromStore(env, taskId);
  const ownerId = String(props?.githubUserId ?? props?.userId ?? "unknown");
  if (task.ownerId !== ownerId) throw new Error("task not found");
  return task;
}

/**
 * @param {Record<string, unknown>} structuredContent
 * @param {string} text
 */
function result(structuredContent, text) {
  return {
    structuredContent,
    content: [{ type: /** @type {const} */ ("text"), text }],
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
