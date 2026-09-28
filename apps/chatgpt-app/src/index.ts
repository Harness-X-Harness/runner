import {
  OAuthError,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

import { githubGrantTokenExchange } from "./github-user-auth.ts";
import {
  authorizePage,
  completeAuthorizationCallback,
  submitAuthorizationDecision,
} from "./authorization.ts";
import type { AuthorizationEnvironment } from "./authorization.ts";
import type { TaskEnv } from "./task.ts";
import { handleMcpRequest } from "./mcp.ts";
import { OAUTH_SCOPES } from "./oauth-scopes.ts";
import {
  authorizationServerIssuer,
  canonicalMcpResource,
  requireCanonicalResourceParameter,
} from "./oauth-resource.ts";
import { AuthorizationStateObject } from "./authorization-state-object.ts";
import { TaskRuntimeObject } from "./task-runtime-object.ts";
import { internalTaskFetch } from "./task-callback.ts";
import { internalEnvironmentFetch } from "./environment-callback.ts";
import { environmentWebhook } from "./environment-webhook.ts";
export { EnvironmentObject as BoundedEnvironmentObject, EnvironmentAdmissionObject } from "./environment-object.ts";
import authorizationStyles from "@radix-ui/themes/styles.css";
import { AUTH_STYLES_PATH } from "./authorization-view.ts";

export { AuthorizationStateObject, TaskRuntimeObject };

type WorkerEnvironment = TaskEnv & AuthorizationEnvironment & Parameters<typeof internalEnvironmentFetch>[1] &
  Parameters<typeof environmentWebhook>[1] & { TASK_CONTROL_PLANE_URL: string; OAUTH_KV: KVNamespace };

export class McpApi extends WorkerEntrypoint<WorkerEnvironment, Record<string, unknown>> {
  fetch(request: Request): Promise<Response> {
    return handleMcpRequest(request, this.env, this.ctx.props, this.ctx);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Promise<Response> {
    const canonicalResource = canonicalMcpResource(env.TASK_CONTROL_PLANE_URL);
    const resourceError = await requireCanonicalResourceParameter(request);
    if (resourceError) return resourceError;
    return createOAuthProvider(env, canonicalResource).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnvironment>;

function createOAuthProvider(env: WorkerEnvironment, canonicalResource: string): OAuthProvider<WorkerEnvironment> {
  return new OAuthProvider<WorkerEnvironment>({
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
      resource_name: "Harness X Harness",
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

async function defaultFetch(request: Request, env: WorkerEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === AUTH_STYLES_PATH && request.method === "GET") {
    return new Response(authorizationStyles, { headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
    } });
  }
  if (url.pathname === "/health") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  if (url.pathname.startsWith("/internal/tasks/")) return internalTaskFetch(request, env);
  if (url.pathname.startsWith("/internal/environments/")) return internalEnvironmentFetch(request, env);
  if (url.pathname === "/github/events") return environmentWebhook(request, env);

  if (url.pathname === "/authorize" && request.method === "GET") {
    return authorizePage(request, env);
  }

  if (url.pathname === "/authorize/consent" && request.method === "POST") {
    return submitAuthorizationDecision(request, env);
  }

  if (url.pathname === "/github/callback" && request.method === "GET") {
    return completeAuthorizationCallback(request, env);
  }

  return new Response("Not found", { status: 404 });
}
