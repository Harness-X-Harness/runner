import { bearerAuthChallengeResponse, getOAuthProtectedResourceMetadataUrl, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { CallToolResultV2Schema, hasTaskClientCapabilityV2, type DetailedTaskV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import { TaskError } from "../../../shared/task-errors.ts";
import { canonicalMcpResource } from "./oauth-resource.ts";
import { serveTaskRequest, type TaskAuthority } from "./task-methods.ts";
import { mcpAuthorization } from "./mcp-authorization.ts";
import type { EnvironmentObject, EnvironmentSnapshot } from "./environment-object.ts";
import { openEnvironment, closeEnvironment, ENVIRONMENT_SCOPE } from "./environment-service.ts";
import { executionPrincipal } from "./execution-authority.ts";
import { environmentTools, environmentToolDefinitions, inspectInput, updateInput } from "./environment-tools.ts";
import { listEnvironmentResources, listOwnedEnvironments, observeEnvironmentResource, readEnvironmentResource, type EnvironmentResources } from "./environment-resources.ts";
import { lifecycleTaskId, lifecycleIdentity, type LifecycleKind } from "./environment-lifecycle-task.ts";
import { startEnvironmentOperation, getEnvironmentTask, cancelEnvironmentTask, updateEnvironmentTask } from "./environment-operation-service.ts";
import { observeEnvironmentTask } from "./environment-task-observation.ts";
import { ordinaryError, ordinaryToolResult, type OrdinaryDispatch, type OrdinaryTool } from "./environment-ordinary-result.ts";
import { EVENT_NAME, EventError, eventCatalog, eventRpcValue, grantIdentity } from "./mcp-events.ts";
import { WORKBENCH_URI, readWorkbench } from "./workbench-resource.ts";

type Environment = Omit<EnvironmentResources, "ENVIRONMENTS"> & { ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject,
  "initialize" | "dispatchExecution" | "requestClose" | "closeExecution" | "readEnvironment" |
  "readLifecycleTask" | "cancelLifecycleTask" | "observeLifecycleTask" |
  "reserveOperation" | "readOperation" | "readOutput" | "cancelOperation" | "observeOperation" | "observeOutput" | "observeEnvironment" | "answerOperation" |
  "subscribeEvents" | "unsubscribeEvents"> } };

// Exact, public admission refusals. Never classify arbitrary RPC/storage failures
// or errors from reading an already accepted operation as proof of rejection.
const operationRejections = new Set([
  "INVALID_OPERATION_INPUT", "OPERATION_ID_CONFLICT", "ENVIRONMENT_NOT_READY",
  "ENVIRONMENT_RUNTIME_BUSY", "ENVIRONMENT_CLOSING", "ENVIRONMENT_IDLE_EXPIRED",
  "ENVIRONMENT_NOT_FOUND", "OPERATION_RECEIPT_CAPACITY",
]);

export async function handleEnvironmentTaskRequest(request: Request,
  env: Environment & Parameters<typeof mcpAuthorization>[1]): Promise<Response> {
  const authorize = mcpAuthorization(request, env);
  const challenge = (error: unknown) => bearerAuthChallengeResponse(error, {
    requiredScopes: [ENVIRONMENT_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(canonicalMcpResource(env.TASK_CONTROL_PLANE_URL))),
  });
  let props: Record<string, unknown>;
  try { props = await authorize(); }
  catch (error) {
    return challenge(error instanceof TaskError && error.code === "TASK_AUTH_REQUIRED"
      ? new OAuthError(OAuthErrorCode.InvalidToken, "A valid access token is required")
      : new OAuthError(OAuthErrorCode.ServerError, "Authorization is temporarily unavailable"));
  }
  try { executionPrincipal(props, ENVIRONMENT_SCOPE); }
  catch { return challenge(new OAuthError(OAuthErrorCode.InsufficientScope, "Environment permission is required")); }
  // Preflight permits an HTTP challenge before streaming. Delivery still rereads authority.
  return serveTaskRequest(request, environmentTaskAuthority(env, authorize));
}

/** Task methods still stop before this authority. Ordinary tool calls opt in, then select one contract. */
export function environmentTaskAuthority(env: Environment, authorize: () => Promise<Record<string, unknown>>): TaskAuthority {
  return {
    ordinaryToolCalls: true,
    events: { async handle(request) {
      const props = await authorize();
      const owner = executionPrincipal(props, ENVIRONMENT_SCOPE);
      if (request.method === "events/list") {
        if (request.params?.cursor !== undefined) throw new EventError(-32602, "Invalid event cursor");
        return eventCatalog;
      }
      if (request.params.name !== EVENT_NAME) throw new EventError(-32011, "Event not found", { kind: "event" });
      const object = env.ENVIRONMENTS.getByName(request.params.arguments.environmentId);
      const snapshot = await object.readEnvironment(owner);
      if (!snapshot) throw new EventError(-32012, "Environment not found or not owned");
      if (request.method === "events/unsubscribe") return eventRpcValue(await object.unsubscribeEvents(owner, request.params));
      return eventRpcValue(await object.subscribeEvents(owner, grantIdentity.parse(props.mcpGrant), request.params));
    } },
    async tools() {
      executionPrincipal(await authorize(), ENVIRONMENT_SCOPE);
      return { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: environmentTools() };
    },
    async resources(cursor) {
      if (cursor !== undefined) throw new Error("INVALID_RESOURCE_CURSOR");
      return listEnvironmentResources(env, await authorize());
    },
    async readResource(uri) {
      const props = await authorize();
      executionPrincipal(props, ENVIRONMENT_SCOPE);
      return uri === WORKBENCH_URI ? readWorkbench() : readEnvironmentResource(env, props, uri);
    },
    async call(request) {
      const props = await authorize();
      const { name, arguments: args } = request.params;
      executionPrincipal(props, ENVIRONMENT_SCOPE);
      const definition = environmentToolDefinitions.find(tool => tool.name === name);
      if (!definition) throw new Error("UNKNOWN_TOOL");
      const parsed = definition.schema.safeParse(args);
      if (!parsed.success) {
        // Report schema-owned field names, never user values or arbitrary object keys.
        const fields = Object.keys(definition.schema.shape);
        const invalid = [...new Set(parsed.error.issues.map(issue =>
          fields.includes(String(issue.path[0])) ? String(issue.path[0]) : "arguments"))];
        return ordinaryError(`Invalid ${name} input: ${invalid.join(", ")}. Follow the tool input schema.`);
      }
      if (name === "list_environments" || name === "show_workbench") {
        const snapshots = await listOwnedEnvironments(env, props);
        if (name === "show_workbench" && snapshots.length === 1) {
          // Re-read through the ordinary owner-checked projection: membership and
          // lifecycle can race. Missing/failed reads must never become an empty list.
          return inspectOrdinary(env, props, { environmentId: snapshots[0]!.environmentId }, "show_workbench");
        }
        return directoryResult(snapshots);
      }
      if (name === "inspect_environment") return inspectOrdinary(env, props, inspectInput.parse(parsed.data));
      if (name === "update_operation") {
        const update = updateInput.parse(parsed.data);
        if (update.action === "cancel") await cancelEnvironmentTask(env, props, update.operationId);
        else await updateEnvironmentTask(env, props, update.operationId, update.inputResponses);
        return inspectOrdinary(env, props, { environmentId: `env_${update.operationId.slice(5, 37)}`,
          operationId: update.operationId }, "update_operation");
      }
      const capable = hasTaskClientCapabilityV2(request.params);
      if (name === "open_environment") {
        const opened = await openEnvironment(env, props, args);
        if (!opened.admitted) {
          const existing = opened.capacityKind === "owner" ? opened.existingEnvironment : undefined;
          return CallToolResultV2Schema.parse({ resultType: "complete", isError: true,
            structuredContent: { outcome: "capacity_rejected", capacityKind: opened.capacityKind,
              retryable: opened.retryable, ...(existing ? { existingEnvironment: existing } : {}) },
            content: [{ type: "text", text: existing
              ? `You already have a workspace. environmentId=${existing.environmentId}${existing.status ? `, status=${existing.status}` : ""}. Open that workspace, or close it before you start another. Do not retry this open.`
              : "No room for a new workspace right now. Nothing was started. Try again later. Do not poll." }],
          });
        }
        return projectLifecycle(env, props, capable, name, opened.environmentId, "open", opened.dispatch);
      }
      if (name === "close_environment") {
        let closed: { environmentId: string };
        try { closed = await closeEnvironment(env, props, args); }
        catch (error) {
          if (!(error instanceof TaskError) || error.code !== "ENVIRONMENT_NOT_FOUND") throw error;
          return ordinaryError(error.message);
        }
        return projectLifecycle(env, props, capable, name, closed.environmentId, "close");
      }
      if (name !== "command" && name !== "agent") throw new Error("UNKNOWN_TOOL");
      const environmentId = operationEnvironmentId(parsed.data);
      let taskId: string;
      try { ({ taskId } = await startEnvironmentOperation(env, props, { ...parsed.data, kind: name })); }
      catch (error) {
        if (!(error instanceof Error) || !operationRejections.has(error.message)) throw error;
        return ordinaryError(error.message);
      }
      const operation = await getEnvironmentTask(env, props, taskId);
      if (capable) return operation.status === "completed" ? operation.result : { ...operation, resultType: "task" };
      const environment = await readOwnedEnvironment(env, props, environmentId);
      if (!environment) return ordinaryError(`Operation ${taskId} was accepted, but Environment ${environmentId} could not be read. Inspect that ID before submitting more work.`);
      return ordinaryToolResult({ tool: name, operation, environment });
    },
    async handle(request) {
      const props = await authorize();
      if (request.method === "tasks/get") return { ...await getEnvironmentTask(env, props, request.params.taskId), resultType: "complete" };
      if (request.method === "tasks/cancel") return cancelEnvironmentTask(env, props, request.params.taskId);
      return updateEnvironmentTask(env, props, request.params.taskId, request.params.inputResponses);
    },
    async observe(taskIds, signal) {
      const entries = await Promise.all(taskIds.map(async taskId => [taskId,
        await observeEnvironmentTask(env, authorize, taskId, signal),
      ] as const));
      return new Map(entries);
    },
    async observeResources(uris, signal) {
      return new Map(await Promise.all(uris.map(async uri => [uri,
        await observeEnvironmentResource(env, authorize, uri, signal),
      ] as const)));
    },
  };
}

async function projectLifecycle(env: Environment, props: unknown, capable: boolean, tool: OrdinaryTool,
  environmentId: string, kind: LifecycleKind, dispatch?: OrdinaryDispatch) {
  const operation = await getEnvironmentTask(env, props, lifecycleTaskId(environmentId, kind));
  if (capable) return operation.status === "completed" ? operation.result : { ...operation, resultType: "task" as const };
  const environment = await readOwnedEnvironment(env, props, environmentId);
  if (!environment) return ordinaryError(`Environment ${environmentId} was accepted, but its current status could not be read. Inspect that ID before submitting more work.`);
  return ordinaryToolResult({ tool, operation, dispatch, environment });
}

async function inspectOrdinary(env: Environment, props: unknown, input: { environmentId: string; operationId?: string },
  tool: "inspect_environment" | "show_workbench" | "update_operation" = "inspect_environment") {
  if (input.operationId && !input.operationId.startsWith(`task_${input.environmentId.slice(4)}_`)) {
    return ordinaryError("Invalid inspect_environment input: operationId. Follow the tool input schema.");
  }
  const environment = await readOwnedEnvironment(env, props, input.environmentId);
  if (!environment) return ordinaryError(new TaskError("ENVIRONMENT_NOT_FOUND").message);
  const activeId = environment.activeTaskId;
  let operation: DetailedTaskV2 | undefined;
  let activeOperation: DetailedTaskV2 | undefined;
  let activeUnreadable = false;
  if (input.operationId) {
    try { operation = await getEnvironmentTask(env, props, input.operationId); }
    catch (error) {
      if (!(error instanceof TaskError) || error.code !== "TASK_NOT_FOUND") throw error;
      return ordinaryError(new TaskError("TASK_NOT_FOUND").message);
    }
    if (activeId && activeId !== input.operationId) {
      try { activeOperation = await getEnvironmentTask(env, props, activeId); }
      catch (error) {
        if (!(error instanceof TaskError) || error.code !== "TASK_NOT_FOUND") throw error;
        activeUnreadable = true;
      }
    }
  } else if (activeId) {
    try { operation = await getEnvironmentTask(env, props, activeId); }
    catch (error) {
      if (!(error instanceof TaskError) || error.code !== "TASK_NOT_FOUND") throw error;
      activeUnreadable = true;
    }
  }
  const historical = operation !== undefined && activeId !== null && activeId !== operation.taskId;
  const output = operation && !lifecycleIdentity(operation.taskId)
    ? await env.ENVIRONMENTS.getByName(input.environmentId).readOutput(executionPrincipal(props, ENVIRONMENT_SCOPE), operation.taskId)
    : undefined;
  return ordinaryToolResult({ tool, environment, operation, activeOperation, activeUnreadable, historical,
    output: output ?? undefined });
}

function directoryResult(snapshots: EnvironmentSnapshot[]) {
  const environments = snapshots.map(({ environmentId, executor, status, reason, expiresAt, idleExpiresAt }) =>
    ({ environmentId, executor, status, expiresAt, ...(reason ? { reason } : {}),
      ...(idleExpiresAt !== undefined ? { idleExpiresAt } : {}) }));
  return CallToolResultV2Schema.parse({ resultType: "complete", structuredContent: { environments },
    content: [{ type: "text", text: environments.length
      ? environments.map(value => `${value.environmentId}: ${value.executor}, ${value.status}${value.reason ? ` (${value.reason})` : ""}`).join("\n")
      : "You have no live Environments." }],
  });
}

function readOwnedEnvironment(env: Environment, props: unknown, environmentId: string): Promise<EnvironmentSnapshot | null> {
  return env.ENVIRONMENTS.getByName(environmentId).readEnvironment(executionPrincipal(props, ENVIRONMENT_SCOPE));
}

function operationEnvironmentId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("environmentId" in value) || typeof value.environmentId !== "string") {
    throw new TaskError("ENVIRONMENT_NOT_FOUND");
  }
  return value.environmentId;
}
