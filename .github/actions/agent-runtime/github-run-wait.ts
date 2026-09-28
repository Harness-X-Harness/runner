import { z } from "zod";

import { githubRunInput, githubRunConclusion, exactCompletion, type GithubRunInput, type GithubRunCompletion } from "./github-run-contract.ts";
export type { GithubRunCompletion } from "./github-run-contract.ts";

const run = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  run_attempt: z.number().int().positive(), head_sha: z.string(),
  repository: z.object({ full_name: z.string() }),
  status: z.enum(["queued", "in_progress", "waiting", "pending", "requested", "completed"]),
  conclusion: githubRunConclusion.nullable(),
});

export type RegisteredRunWait = {
  /** Resolves only from the committed receipt, including a raced event. */
  result: Promise<GithubRunCompletion>;
  commit(result: GithubRunCompletion): Promise<void>;
  /** Ends this observer; cancellation/lease cleanup belongs to the registration. */
  close(): Promise<void>;
};

/** register must enforce configured event coverage and bind the active owner,
 * Environment and Task before returning. The work token never enters storage. */
export async function waitForGithubRun(value: unknown, workToken: string, signal: AbortSignal,
  register: (input: GithubRunInput, signal: AbortSignal) => Promise<RegisteredRunWait>, fetchImpl = fetch) {
  const input = githubRunInput.parse(value);
  signal.throwIfAborted();
  if (!workToken) throw new Error("CI_WORK_AUTHORITY_REQUIRED");
  const registered = await register(input, signal);
  // Delivery can fail before the authority read ends; consume that rejection
  // without replacing its result or letting an early event bypass access checks.
  void registered.result.catch(() => {});
  try {
    signal.throwIfAborted();
    const response = await fetchImpl(`https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}`, {
      headers: { Authorization: `Bearer ${workToken}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "harness-runner" },
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 || response.status === 404
      ? "CI_WORK_AUTHORITY_DENIED" : "CI_OBSERVATION_FAILED");
    const observed = run.parse(await response.json());
    if (String(observed.id) !== input.runId || observed.run_attempt !== input.runAttempt ||
        observed.head_sha !== input.revision || observed.repository.full_name !== input.repository) {
      throw new Error("CI_WAIT_IDENTITY_MISMATCH");
    }
    signal.throwIfAborted();
    if (observed.status === "completed") {
      if (observed.conclusion === null) throw new Error("CI_OBSERVATION_FAILED");
      await registered.commit({ ...input, conclusion: observed.conclusion });
    }
    // No timer or repeated GitHub read. The enclosing Environment owns deadline.
    const result = await registered.result;
    signal.throwIfAborted();
    return exactCompletion(input, result);
  } finally { await registered.close(); }
}
