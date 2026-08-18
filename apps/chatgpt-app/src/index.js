import {
  OAuthError,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { githubGrantTokenExchange } from "./github-user-auth.js";
import {
  authorizePage,
  completeAuthorizationCallback,
  submitAuthorizationDecision,
} from "./authorization.js";
import { handleMcpRequest } from "./mcp.js";
import { OAUTH_SCOPES } from "./oauth-scopes.js";
import {
  authorizationServerIssuer,
  canonicalMcpResource,
  requireCanonicalResourceParameter,
} from "./oauth-resource.js";
import {
  startInstallationAuthorization,
} from "./repository-authorization.js";
import { TaskObject } from "./task-object.js";
import { AuthorizationStateObject } from "./authorization-state-object.js";
import { EnvironmentObject } from "./environment-object.js";
import { environmentEntry } from "./environment-page.js";
import {
  claimEnvironmentRun,
  openEnvironmentChannel,
  prepareEnvironmentChannel,
} from "./environment-callback.js";
import { trustedRunnerClaims, webSocketRunnerToken } from "./runner-identity.js";
import { sessionStreamFetch } from "./session-stream.js";

export { AuthorizationStateObject, EnvironmentObject, TaskObject };

export class McpApi extends WorkerEntrypoint {
  fetch(request) {
    return handleMcpRequest(request, this.env, this.ctx.props, this.ctx);
  }
}

export default {
  async fetch(request, env, ctx) {
    const canonicalResource = canonicalMcpResource(env.TASK_CONTROL_PLANE_URL);
    const resourceError = await requireCanonicalResourceParameter(request);
    if (resourceError) return resourceError;
    return createOAuthProvider(env, canonicalResource).fetch(request, env, ctx);
  },
};

function createOAuthProvider(env, canonicalResource) {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: McpApi,
    defaultHandler: { fetch: defaultFetch },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...OAUTH_SCOPES],
    resourceMetadata: {
      resource: canonicalResource,
      authorization_servers: [authorizationServerIssuer(env.TASK_CONTROL_PLANE_URL)],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Harness X Harness Task Runner",
    },
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: async (options) => {
      try {
        return await githubGrantTokenExchange(env, options);
      } catch {
        throw new OAuthError("invalid_grant", {
          description: "GitHub authorization expired or was revoked",
        });
      }
    },
  });
}

async function defaultFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  if (url.pathname.startsWith("/internal/tasks/")) {
    return internalTaskFetch(request, env, url);
  }

  if (url.pathname.startsWith("/internal/environments/")) {
    return internalEnvironmentFetch(request, env, url);
  }

  if (url.pathname.startsWith("/task-stream/")) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: privateStreamCorsHeaders() });
    }
    if (request.method === "GET") return taskStreamFetch(request, env, url);
  }

  if (url.pathname.startsWith("/session-stream/")) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: privateStreamCorsHeaders() });
    }
    if (request.method === "GET") return sessionStreamFetch(request, env, url);
  }

  if (url.pathname === "/environment" && request.method === "GET") {
    return environmentEntry(request, env);
  }

  if (url.pathname === "/authorize" && request.method === "GET") {
    return authorizePage(request, env);
  }

  if (url.pathname === "/authorize/consent" && request.method === "POST") {
    return submitAuthorizationDecision(request, env);
  }

  if (url.pathname === "/github/callback" && request.method === "GET") {
    return completeAuthorizationCallback(request, env);
  }

  if (url.pathname === "/github/install" && request.method === "GET") {
    return startInstallationAuthorization(request, env);
  }

  return new Response("Not found", { status: 404 });
}

async function internalEnvironmentFetch(request, env, url) {
  const operation = url.pathname.split("/").at(-1);
  const websocket = operation === "channel" &&
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (!websocket && (request.method !== "POST" || !["claim", "channel"].includes(operation))) {
    return json({ error: "not found" }, 404);
  }
  let claims;
  try {
    const token = websocket ? webSocketRunnerToken(request) : undefined;
    claims = await verifyRunnerIdentity(
      request,
      env,
      env.GITHUB_ENVIRONMENT_WORKFLOW_ID ?? "private-runner-session.yml",
      token,
    );
  } catch {
    return json({ error: "runner authorization required" }, 401);
  }
  const environmentId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  if (websocket) return openEnvironmentChannel(env, environmentId, claims);
  if (operation === "claim") {
    return claimEnvironmentRun(
      env,
      environmentId,
      String(claims.run_id),
      String(claims.run_attempt),
      `https://github.com/${env.GITHUB_RUNNER_REPOSITORY}/actions/runs/${claims.run_id}`,
    );
  }
  return prepareEnvironmentChannel(
    env,
    environmentId,
    String(claims.run_id),
    String(claims.run_attempt),
    await request.json(),
  );
}

async function internalTaskFetch(request, env, url) {
  let claims;
  try {
    claims = await verifyRunnerIdentity(request, env);
  } catch {
    return json({ error: "runner authorization required" }, 401);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const taskId = parts[2];
  if (!taskId || (parts[3] !== undefined && !["events", "stream"].includes(parts[3]))) {
    return json({ error: "not found" }, 404);
  }
  const stub = env.TASKS.get(env.TASKS.idFromName(taskId));
  const taskResponse = await stub.fetch("https://task/task");
  if (!taskResponse.ok) return json({ error: "task not found" }, 404);
  const task = await taskResponse.json();
  if (task.runnerRepository !== undefined && task.runnerRepository !== env.GITHUB_RUNNER_REPOSITORY) {
    return json({ error: "task not found" }, 404);
  }
  const claimRunId = String(claims.run_id ?? "");
  if (task.runId !== undefined && String(task.runId) !== claimRunId) {
    return json({ error: "task not found" }, 404);
  }
  if (request.method === "GET" && parts[3] === undefined) {
    return json({
      taskId: task.id,
      repo: task.repo,
      ref: task.ref,
      executor: task.executor,
      mode: task.mode,
      status: task.status,
      prompt: task.prompt,
      runnerRepository: claims.repository,
    });
  }
  if (request.method === "POST" && parts[3] === "events") {
    const event = await request.json();
    if (event.runId !== undefined && String(event.runId) !== claimRunId) {
      return json({ error: "run identity does not match task" }, 403);
    }
    const updated = await stub.fetch("https://task/task", {
      method: "PATCH",
      body: JSON.stringify(event),
    });
    return new Response(await updated.text(), {
      status: updated.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (request.method === "POST" && parts[3] === "stream") {
    const streamed = await stub.fetch("https://task/task/stream-events", {
      method: "POST",
      body: JSON.stringify(await request.json()),
    });
    return new Response(await streamed.text(), {
      status: streamed.status,
      headers: { "content-type": "application/json" },
    });
  }
  return json({ error: "method not allowed" }, 405);
}

async function taskStreamFetch(request, env, url) {
  const taskId = decodeURIComponent(url.pathname.slice("/task-stream/".length));
  if (!taskId || taskId.includes("/")) return json({ error: "not found" }, 404);
  const target = new URL("https://task/task/stream");
  const after = url.searchParams.get("after");
  if (after !== null) target.searchParams.set("after", after);
  const response = await env.TASKS.get(env.TASKS.idFromName(taskId)).fetch(target, {
    headers: { authorization: request.headers.get("authorization") ?? "" },
  });
  const headers = new Headers(response.headers);
  for (const [name, value] of privateStreamCorsHeaders()) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function privateStreamCorsHeaders() {
  return new Headers({
    "access-control-allow-headers": "authorization",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
}

const githubOidcKeys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);

async function verifyRunnerIdentity(
  request,
  env,
  workflowId = env.GITHUB_WORKFLOW_ID ?? "execute-task.yml",
  suppliedToken,
) {
  const token = suppliedToken ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("runner identity required");
  const { payload } = await jwtVerify(token, githubOidcKeys, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: env.TASK_CONTROL_PLANE_URL,
  });
  return trustedRunnerClaims(payload, env, workflowId);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
