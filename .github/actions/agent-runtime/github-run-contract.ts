import { z } from "zod";

export const githubRunInput = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  runId: z.string().regex(/^[1-9]\d*$/),
  runAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export const githubRunConclusion = z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"]);
export const githubRunCompletion = githubRunInput.extend({ conclusion: githubRunConclusion });
export type GithubRunInput = z.infer<typeof githubRunInput>;
export type GithubRunCompletion = z.infer<typeof githubRunCompletion>;

export function exactCompletion(input: GithubRunInput, value: unknown): GithubRunCompletion {
  const result = githubRunCompletion.parse(value);
  if (result.repository !== input.repository || result.runId !== input.runId ||
      result.runAttempt !== input.runAttempt || result.revision !== input.revision) throw new Error("CI_WAIT_IDENTITY_MISMATCH");
  return result;
}
