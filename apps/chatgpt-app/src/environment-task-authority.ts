import { z } from "zod";
import { bearerAuthChallengeResponse, getOAuthProtectedResourceMetadataUrl, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { TaskError } from "../../../shared/task-errors.ts";
import { canonicalMcpResource } from "./oauth-resource.ts";
import { serveTaskRequest, type TaskAuthority } from "./task-methods.ts";
import { mcpAuthorization } from "./mcp-authorization.ts";
import type { EnvironmentObject } from "./environment-object.ts";
import { openEnvironment, closeEnvironment, ENVIRONMENT_SCOPE } from "./environment-service.ts";
import { executionPrincipal } from "./execution-authority.ts";
import { environmentTools } from "./environment-tools.ts";
import { listEnvironmentResources, observeEnvironmentResource, readEnvironmentResource, type EnvironmentResources } from "./environment-resources.ts";
import { lifecycleTaskId } from "./environment-lifecycle-task.ts";
import { startEnvironmentOperation, getEnvironmentTask, cancelEnvironmentTask, updateEnvironmentTask } from "./environment-operation-service.ts";
import { observeEnvironmentTask } from "./environment-task-observation.ts";

type Environment = EnvironmentResources & { ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject,
  "initialize" | "dispatchExecution" | "requestClose" | "closeExecution" |
  "readLifecycleTask" | "cancelLifecycleTask" | "observeLifecycleTask" |
  "reserveOperation" | "readOperation" | "cancelOperation" | "observeOperation" | "observeOutput" | "observeEnvironment" | "answerOperation"> } };

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

/** The transport checks client capabilities before entering this effectful authority. */
export function environmentTaskAuthority(env: Environment, authorize: () => Promise<Record<string, unknown>>): TaskAuthority {
  return {
    async tools() {
      executionPrincipal(await authorize(), ENVIRONMENT_SCOPE);
      return { resultType: "complete", tools: environmentTools() };
    },
    async resources(cursor) {
      if (cursor !== undefined) throw new Error("INVALID_RESOURCE_CURSOR");
      return listEnvironmentResources(env, await authorize());
    },
    async readResource(uri) {
      return readEnvironmentResource(env, await authorize(), uri);
    },
    async call(request) {
      const props = await authorize();
      const { name, arguments: args } = request.params;
      if (name === "open_environment" || name === "close_environment") {
        const kind = name === "open_environment" ? "open" : "close";
        const value = kind === "open" ? await openEnvironment(env, props, args) : await closeEnvironment(env, props, args);
        const task = await getEnvironmentTask(env, props, lifecycleTaskId(value.environmentId, kind));
        return task.status === "completed" ? task.result : { ...task, resultType: "task" };
      }
      if (name !== "command" && name !== "agent") throw new Error("UNKNOWN_TOOL");
      const input = z.record(z.string(), z.unknown()).parse(args);
      if (Object.hasOwn(input, "kind")) throw new Error("INVALID_OPERATION_INPUT");
      const { taskId } = await startEnvironmentOperation(env, props, { ...input, kind: name });
      const snapshot = await getEnvironmentTask(env, props, taskId);
      return snapshot.status === "completed" ? snapshot.result : { ...snapshot, resultType: "task" };
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
