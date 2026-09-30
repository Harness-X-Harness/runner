import { OAuthError, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { githubGrantTokenExchange } from "./github-user-auth.ts";
import { OAUTH_SCOPES } from "./oauth-scopes.ts";
import { authorizationServerIssuer, canonicalMcpResource } from "./oauth-resource.ts";

type Environment = Parameters<typeof githubGrantTokenExchange>[0] & { TASK_CONTROL_PLANE_URL: string };
/** One configuration for request handling and the provider's public background API. */
export function oauthOptions<Env extends Environment>(env: Env): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp", defaultHandler: {}, authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register", scopesSupported: [...OAUTH_SCOPES],
    resourceMetadata: { resource: canonicalMcpResource(env.TASK_CONTROL_PLANE_URL),
      authorization_servers: [authorizationServerIssuer(env.TASK_CONTROL_PLANE_URL)],
      scopes_supported: [...OAUTH_SCOPES], bearer_methods_supported: ["header"], resource_name: "Harness X Harness" },
    allowImplicitFlow: false, allowPlainPKCE: false, clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: async options => {
      try { return await githubGrantTokenExchange(env, options); }
      catch { throw new OAuthError("invalid_grant", { description: "GitHub authorization expired or was revoked" }); }
    },
  };
}
