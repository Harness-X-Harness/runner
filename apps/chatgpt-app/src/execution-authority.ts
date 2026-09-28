import { z } from "zod";
import { TaskError } from "../../../shared/task-errors.ts";

const principalSchema = z.object({ oauthScopes: z.array(z.string()),
  githubUserId: z.union([z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]) });
const authoritySchema = z.object({ githubAuthorizationKind: z.literal("github_app_scoped"),
  environmentGithubAccessToken: z.string().min(1), environmentGithubAccessTokenExpiresAt: z.number().optional() });

export function executionPrincipal(props: unknown, scope: string): string {
  const parsed = principalSchema.safeParse(props);
  if (!parsed.success || !parsed.data.oauthScopes.includes(scope) || !/^[1-9]\d{0,19}$/.test(String(parsed.data.githubUserId))) {
    throw new TaskError("TASK_AUTH_REQUIRED");
  }
  return String(parsed.data.githubUserId);
}

export function executionToken(props: unknown): string {
  const parsed = authoritySchema.safeParse(props);
  if (!parsed.success || (parsed.data.environmentGithubAccessTokenExpiresAt !== undefined &&
      parsed.data.environmentGithubAccessTokenExpiresAt <= Date.now() / 1000)) throw new TaskError("TASK_AUTH_REQUIRED");
  return parsed.data.environmentGithubAccessToken;
}
