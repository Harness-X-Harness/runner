import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdir, readFile, writeFile, appendFile, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { claimRunnerEnvironment, serveRunnerEnvironment } from "./environment-identity.ts";
import { readExecutorReport } from "./agent-model.ts";
import { agentEnvironment, configureProvider } from "./provider-config.ts";
import { providerProcess } from "./provider-process.ts";
import { T3Service } from "./t3-service.ts";
import { t3StandaloneEnvironment } from "./t3-provider.ts";
import { homeStateRequested, publishHomeState, restoreHomeState } from "./home-state.ts";

const bootstrapSchema = z.object({ executor: z.enum(["codex", "grok", "t3"]),
  deadline: z.number().int().positive() }).strict();
const reconnectFact = z.object({
  event: z.literal("environment_reconnect_failure"),
  category: z.enum(["runner_identity", "handshake", "handshake_rejected", "control_plane_rejected",
    "transport_closed", "transport_failure", "unknown"]),
  observedAt: z.number().int().positive(),
  closeCode: z.number().int().min(1000).max(4999).optional(),
}).strict();

const ignoreOperatorLogError = () => {};

function location(env: NodeJS.ProcessEnv): string {
  if (!/^env_[a-f0-9]{32}$/.test(env.ENVIRONMENT_ID ?? "") || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) {
    throw new Error("INVALID_ENVIRONMENT_INPUT");
  }
  return path.join(env.RUNNER_TEMP, `harness-${env.ENVIRONMENT_ID}`);
}

export async function claimEnvironment(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<void> {
  const directory = location(env);
  if (!env.GITHUB_OUTPUT) throw new Error("INVALID_ENVIRONMENT_INPUT");
  const claim = await claimRunnerEnvironment(env.TASK_CONTROL_PLANE_URL ?? "", env.ENVIRONMENT_ID!,
    AbortSignal.timeout(10000), env, fetchImpl);
  if (claim.decision === "stop") return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, "claim.json");
  await writeFile(file, JSON.stringify({ executor: claim.executor, deadline: claim.deadline }), { mode: 0o600 });
  await chmod(file, 0o600);
  await appendFile(env.GITHUB_OUTPUT, `executor=${claim.executor}\n`);
}

async function serve(env: NodeJS.ProcessEnv, parentSignal: AbortSignal) {
  const directory = location(env);
  const claim = bootstrapSchema.parse(JSON.parse(await readFile(path.join(directory, "claim.json"), "utf8")));
  if (claim.deadline <= Date.now()) return;
  // Bound installation-independent startup as well as the serving phase. T3
  // startup must not run past the already claimed Environment hard deadline.
  const signal = AbortSignal.any([parentSignal,
    AbortSignal.timeout(Math.max(1, Math.min(claim.deadline - Date.now(), 2_147_483_647)))]);
  signal.throwIfAborted();
  if (!env.GH_TOKEN) throw new Error("AGENT_GITHUB_AUTH_REQUIRED");
  if (claim.executor !== "t3") await configureProvider(claim.executor, env);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const { withEnvironment } = await import("./environment.ts");
  const childEnv = agentEnvironment(env);
  if (claim.executor === "t3" && homeStateRequested(env)) await restoreHomeState(env);
  const t3Env = claim.executor === "t3" ? t3StandaloneEnvironment(childEnv) : undefined;
  const t3 = t3Env ? new T3Service({ workspace, env: t3Env }) : undefined;
  // T3 is standalone: its readiness probe cannot delay or kill a Codex/Grok ACP session.
  // A failed T3 start is reported as a service-state observation, not a fatal Worker error.
  const t3Startup = t3 ? t3.start(signal).catch(() => {}) : Promise.resolve();
  try {
    await withEnvironment(claim.executor === "t3" ? null : providerProcess(claim.executor, workspace, childEnv),
      claim.executor, claim.deadline,
    { PATH: t3Env?.PATH ?? childEnv.PATH, HOME: childEnv.HOME, TMPDIR: childEnv.TMPDIR,
      GH_TOKEN: childEnv.GH_TOKEN }, {
      sessionUpdate: () => {},
      requestPermission: request => {
        const option = request.options.find(value => value.kind === "allow_once" || value.kind === "allow_always");
        return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
      },
      grokExitPlan: async () => ({ outcome: "approved", feedback: null }),
    }, environment => serveRunnerEnvironment(environment, env.TASK_CONTROL_PLANE_URL ?? "", env.ENVIRONMENT_ID!, claim.deadline,
      env, fetch, fact => parentPort?.postMessage({ event: "environment_reconnect_failure", ...fact })), signal, {
      workspace,
      ...(claim.executor !== "t3" ? { readAgentReport: (executor: "codex" | "grok", reportSignal: AbortSignal) =>
        readExecutorReport(executor, env, fetch, reportSignal) } : {}),
      ...(t3 ? { services: { read: () => ({ t3: t3.read() }), subscribe: changed => t3.subscribe(changed),
        issuePairing: (origin: string, pairSignal: AbortSignal) => t3.issuePairing(origin, pairSignal) } } : {}),
    });
  } finally {
    try { await t3?.close(); }
    finally {
      await t3Startup;
      // Publish after T3 has stopped writing. A killed runner never reaches this.
      if (homeStateRequested(env)) await publishHomeState(env);
    }
  }
}

async function main() {
  if (process.argv[2] === "claim") return claimEnvironment();
  if (process.argv[2] !== "serve") throw new Error("INVALID_ENVIRONMENT_INPUT");
  const worker = new Worker(new URL(import.meta.url), { workerData: true, stdout: true, stderr: true });
  return superviseEnvironmentWorker(worker);
}

/** Keep native diagnostics private while forwarding stop to the runtime owner. */
export async function superviseEnvironmentWorker(worker: Worker): Promise<void> {
  worker.stdout!.resume(); worker.stderr!.resume();
  // This entry process owns the operator sink. Keep one guard through process
  // exit: queued/repeated pipe errors can arrive after the worker has exited.
  if (!process.stderr.listeners("error").includes(ignoreOperatorLogError)) {
    process.stderr.on("error", ignoreOperatorLogError);
  }
  const stop = () => worker.postMessage("close");
  const report = (message: unknown) => {
    const fact = reconnectFact.safeParse(message);
    if (fact.success) console.error(JSON.stringify(fact.data));
  };
  worker.on("message", report);
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("error", () => reject(new Error("ENVIRONMENT_RUNTIME_FAILED")));
      worker.on("exit", code => code === 0 ? resolve() : reject(new Error("ENVIRONMENT_RUNTIME_FAILED")));
    });
  } finally { worker.off("message", report); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (!isMainThread && workerData === true) {
  const controller = new AbortController();
  parentPort?.on("message", () => controller.abort());
  serve(process.env, controller.signal).catch(() => { process.exitCode = 1; }).finally(() => parentPort?.close());
} else if (import.meta.main) {
  main().catch(() => { process.stderr.write("Environment runtime failed.\n"); process.exitCode = 1; });
}
