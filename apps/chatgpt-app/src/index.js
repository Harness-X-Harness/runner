import {
  OAuthError,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

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
import { AuthorizationStateObject } from "./authorization-state-object.js";
import { TaskRuntimeObject } from "./task-runtime-object.js";
import { internalTaskFetch } from "./task-callback.js";

export { AuthorizationStateObject, TaskRuntimeObject };

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

async function defaultFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  if (url.pathname.startsWith("/internal/tasks/")) return internalTaskFetch(request, env);

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
