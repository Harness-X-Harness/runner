import {
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

import { oauthOptions } from "./oauth-options.ts";
import {
  authorizePage,
  completeAuthorizationCallback,
  submitAuthorizationDecision,
} from "./authorization.ts";
import type { AuthorizationEnvironment } from "./authorization.ts";
import { handleEnvironmentTaskRequest } from "./environment-task-authority.ts";
import {
  requireCanonicalResourceParameter,
} from "./oauth-resource.ts";
import { AuthorizationStateObject } from "./authorization-state-object.ts";
import { internalEnvironmentFetch } from "./environment-callback.ts";
import { environmentWebhook } from "./environment-webhook.ts";
export { EnvironmentObject as BoundedEnvironmentObject, EnvironmentAdmissionObject } from "./environment-object.ts";
import authorizationStyles from "@radix-ui/themes/styles.css";
import pixelAuthStyles from "../ui/auth-pixel.css";
import { AUTH_STYLES_PATH } from "./authorization-view.ts";
import { observeMcpEventRequest } from "./mcp-event-diagnostics.ts";

export { AuthorizationStateObject };
export { EventDeliveryContainer } from "./event-delivery.ts";

type WorkerEnvironment = AuthorizationEnvironment & Parameters<typeof internalEnvironmentFetch>[1] &
  Parameters<typeof handleEnvironmentTaskRequest>[1] &
  Parameters<typeof environmentWebhook>[1] & { TASK_CONTROL_PLANE_URL: string; OAUTH_KV: KVNamespace };

export class McpApi extends WorkerEntrypoint<WorkerEnvironment, Record<string, unknown>> {
  fetch(request: Request): Promise<Response> {
    return handleEnvironmentTaskRequest(request, this.env);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Promise<Response> {
    return observeMcpEventRequest(request, async () => {
      const resourceError = await requireCanonicalResourceParameter(request);
      if (resourceError) return resourceError;
      return createOAuthProvider(env).fetch(request, env, ctx);
    });
  },
} satisfies ExportedHandler<WorkerEnvironment>;

function createOAuthProvider(env: WorkerEnvironment): OAuthProvider<WorkerEnvironment> {
  return new OAuthProvider<WorkerEnvironment>({
    ...oauthOptions(env),
    apiHandler: McpApi,
    defaultHandler: { fetch: defaultFetch },
  });
}

async function defaultFetch(request: Request, env: WorkerEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === AUTH_STYLES_PATH && request.method === "GET") {
    return new Response(`${authorizationStyles}\n${pixelAuthStyles}`, { headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
    } });
  }
  if (url.pathname === "/health") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

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
