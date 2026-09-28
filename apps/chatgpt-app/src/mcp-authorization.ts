import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { canonicalMcpResource } from "./oauth-resource.ts";
import { TaskError } from "../../../shared/task-errors.ts";

type Environment = { OAUTH_PROVIDER: Pick<OAuthHelpers, "unwrapToken">; TASK_CONTROL_PLANE_URL: string };
const propsSchema = z.looseObject({ githubUserId: z.union([z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]) });

/** Each call re-reads the provider's token authority; never memoize this closure. */
export function mcpAuthorization(request: Request, env: Environment): () => Promise<Record<string, unknown>> {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const resource = canonicalMcpResource(env.TASK_CONTROL_PLANE_URL);
  return async () => {
    if (!bearer) throw new TaskError("TASK_AUTH_REQUIRED");
    const token = await env.OAUTH_PROVIDER.unwrapToken<unknown>(bearer);
    if (!token || token.expiresAt <= Date.now() / 1000 ||
        !(Array.isArray(token.audience) ? token.audience : [token.audience]).includes(resource)) {
      throw new TaskError("TASK_AUTH_REQUIRED");
    }
    const parsed = propsSchema.safeParse(token.grant.props);
    if (!parsed.success || !/^[1-9]\d{0,19}$/.test(String(parsed.data.githubUserId)) ||
        token.userId !== `github-${parsed.data.githubUserId}`) throw new TaskError("TASK_AUTH_REQUIRED");
    // Downscoped access tokens must not inherit broader scopes from encrypted props.
    return { ...parsed.data, oauthScopes: token.scope };
  };
}
