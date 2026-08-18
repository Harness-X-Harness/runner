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

export { AuthorizationStateObject, EnvironmentObject };

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

  if (url.pathname.startsWith("/internal/environments/")) {
    return internalEnvironmentFetch(request, env, url);
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
  workflowId,
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
