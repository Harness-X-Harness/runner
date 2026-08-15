import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

const SECURITY_SCHEMES = Object.freeze({
  submit_task: Object.freeze([{ type: "oauth2", scopes: ["tasks:run", "repos:read", "repos:write", "pull_requests:write"] }]),
  get_task: Object.freeze([{ type: "oauth2", scopes: ["tasks:read"] }]),
  cancel_task: Object.freeze([{ type: "oauth2", scopes: ["tasks:cancel"] }]),
  get_task_result: Object.freeze([{ type: "oauth2", scopes: ["tasks:read"] }]),
});

const statusSchema = z.enum(TASK_STATUSES);
const taskOutputSchema = {
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
};

export function createServer(env, props) {
  const server = new McpServer(
    { name: "harness-x-harness-task-runner", version: "1.0.0" },
    {
      instructions:
        "Use submit_task to start a task, then get_task to follow progress. Use get_task_result only after completion.",
    },
  );

  server.registerTool(
    "submit_task",
    {
      title: "Submit code task",
      description: "Use this when the user wants an authorized repository task executed by a selected coding agent.",
      inputSchema: {
        repo: z.string().describe("GitHub repository in owner/repository form."),
        prompt: z.string().describe("The coding task instructions; they are retained privately by the control plane."),
        executor: z.enum(EXECUTORS).describe("Coding executor to run."),
        ref: z.string().optional().describe("Branch, tag, or commit; defaults to main."),
        mode: z.enum(MODES).optional().describe("analyze, edit, or pull_request; defaults to analyze."),
      },
      outputSchema: {
        taskId: z.string(),
        status: statusSchema,
        repo: z.string(),
        executor: z.enum(EXECUTORS),
        createdAt: z.string(),
        authorizationUrl: z.string().optional(),
        requiredPermissions: z.array(z.string()).optional(),
      },
      _meta: { securitySchemes: SECURITY_SCHEMES.submit_task },
      annotations: annotations("submit_task"),
    },
    async (input) => {
      requireScopes(props, SECURITY_SCHEMES.submit_task[0].scopes);
      const taskInput = validateSubmitInput(input);
      const baseTask = {
        id: `task_${crypto.randomUUID()}`,
        ...taskInput,
        ownerId: String(props?.githubUserId ?? props?.userId ?? "unknown"),
        runnerRepository: env.GITHUB_RUNNER_REPOSITORY,
        createdAt: new Date().toISOString(),
      };
      const access = await resolveRepositoryAccess(env, props, baseTask);
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

  server.registerTool(
    "get_task",
    {
      title: "Get task status",
      description: "Use this when the user wants the current status of a previously submitted code task.",
      inputSchema: { taskId: z.string() },
      outputSchema: taskOutputSchema,
      _meta: { securitySchemes: SECURITY_SCHEMES.get_task },
      annotations: annotations("get_task"),
    },
    async ({ taskId }) => {
      requireScopes(props, SECURITY_SCHEMES.get_task[0].scopes);
      const task = await readOwnedTask(env, taskId, props);
      return result(publicTask(task), `Task ${task.id} is ${task.status}.`);
    },
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel code task",
      description: "Use this when the user explicitly wants a queued or running code task cancelled.",
      inputSchema: { taskId: z.string() },
      outputSchema: taskOutputSchema,
      _meta: { securitySchemes: SECURITY_SCHEMES.cancel_task },
      annotations: annotations("cancel_task"),
    },
    async ({ taskId }) => {
      requireScopes(props, SECURITY_SCHEMES.cancel_task[0].scopes);
      const task = await readOwnedTask(env, taskId, props);
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

  server.registerTool(
    "get_task_result",
    {
      title: "Get task result",
      description: "Use this when a code task has completed and the user wants its summary, commit, or pull request.",
      inputSchema: { taskId: z.string() },
      outputSchema: taskOutputSchema,
      _meta: { securitySchemes: SECURITY_SCHEMES.get_task_result },
      annotations: annotations("get_task_result"),
    },
    async ({ taskId }) => {
      requireScopes(props, SECURITY_SCHEMES.get_task_result[0].scopes);
      const task = await readOwnedTask(env, taskId, props);
      return result(publicTask(task), `Task ${task.id} is ${task.status}.`);
    },
  );

  exposeSecuritySchemes(server);
  return server;
}

export function handleMcpRequest(request, env, props, ctx) {
  return createMcpHandler(createServer(env, props), {
    route: "/mcp",
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })(request, env, ctx);
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

function exposeSecuritySchemes(server) {
  // The pinned MCP SDK serializes extension fields under `_meta`; preserve
  // that compatibility mirror and add the Apps SDK top-level field as well.
  const listHandler = server.server?._requestHandlers?.get("tools/list");
  if (!listHandler) throw new Error("MCP tools/list handler is unavailable");

  server.server.removeRequestHandler("tools/list");
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await listHandler(request, extra);
    return {
      ...result,
      tools: result.tools.map((tool) => ({
        ...tool,
        securitySchemes: SECURITY_SCHEMES[tool.name],
        _meta: {
          ...(tool._meta ?? {}),
          securitySchemes: SECURITY_SCHEMES[tool.name],
        },
      })),
    };
  });
}
