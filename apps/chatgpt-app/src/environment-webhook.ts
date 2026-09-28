import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";
import { ENVIRONMENT_WORKFLOW } from "./environment-callback.ts";
import { executionObservation } from "./task-github.ts";
import type { EnvironmentObject, EnvironmentAdmissionObject } from "./environment-object.ts";
import { githubRunCompletion } from "../../../.github/actions/agent-runtime/github-run-contract.ts";

type Environment = {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_RUNNER_REPOSITORY: string;
  GITHUB_CI_EVENT_REPOSITORIES?: string;
  ENVIRONMENT_ADMISSION: { getByName(name: string): Pick<EnvironmentAdmissionObject, "held"> };
  ENVIRONMENTS: { getByName(name: string): Pick<EnvironmentObject, "confirmExecutionStopped" | "completeGithubWaits"> };
};
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const eventSchema = z.object({
  action: z.string(), repository: z.object({ full_name: z.string() }),
  workflow_run: z.looseObject({ id, run_attempt: id, display_title: z.string(),
    actor: z.object({ id }), path: z.string(), status: z.string() }),
});

/** Signed GitHub completion, not a runner callback. Never creates execution authority. */
export async function environmentWebhook(request: Request, env: Environment): Promise<Response> {
  const reply = (status: number) => new Response(null, { status });
  if (request.method !== "POST") return reply(405);
  if (!env.GITHUB_WEBHOOK_SECRET) return reply(503);
  const payload = await request.text();
  try {
    if (!await verify(env.GITHUB_WEBHOOK_SECRET, payload, request.headers.get("x-hub-signature-256") ?? "")) return reply(401);
  } catch { return reply(401); }
  if (request.headers.get("x-github-event") !== "workflow_run") return reply(202);
  let parsed: z.infer<typeof eventSchema>;
  try { parsed = eventSchema.parse(JSON.parse(payload)); }
  catch { return reply(400); }
  const run = parsed.workflow_run;
  if (parsed.action !== "completed") return reply(202);
  const environmentRun = run.path === `.github/workflows/${ENVIRONMENT_WORKFLOW}` &&
    parsed.repository.full_name === env.GITHUB_RUNNER_REPOSITORY;
  let covered: boolean;
  try { covered = z.array(z.string()).parse(JSON.parse(env.GITHUB_CI_EVENT_REPOSITORIES ?? "[]")).includes(parsed.repository.full_name); }
  catch { return reply(503); }
  if (!environmentRun && !covered) return reply(202);
  if (environmentRun && !/^env_[a-f0-9]{32}$/.test(run.display_title)) return reply(400);
  const execution = { ownerId: String(run.actor.id), repository: parsed.repository.full_name,
    runId: String(run.id), runAttempt: String(run.run_attempt) };
  try {
    if (environmentRun && executionObservation(run, execution, ENVIRONMENT_WORKFLOW).status !== "completed") return reply(400);
  } catch { return reply(400); }
  const ci = covered ? githubRunCompletion.safeParse({ repository: parsed.repository.full_name,
    runId: String(run.id), runAttempt: run.run_attempt, revision: run.head_sha, conclusion: run.conclusion }) : undefined;
  if (ci && (!ci.success || run.status !== "completed" ||
      !z.object({ repository: z.object({ full_name: z.literal(parsed.repository.full_name) }) }).safeParse(run).success)) return reply(400);
  try {
    // The DO rechecks against its existing binding before changing state.
    if (environmentRun) await env.ENVIRONMENTS.getByName(run.display_title).confirmExecutionStopped(execution);
    if (ci?.success) {
      const held = await env.ENVIRONMENT_ADMISSION.getByName("global").held();
      await Promise.all(held.map(id => env.ENVIRONMENTS.getByName(id).completeGithubWaits(ci.data)));
    }
    return reply(204);
  } catch {
    // Do not acknowledge failed durable delivery; no raw payload/error logging.
    return reply(503);
  }
}
