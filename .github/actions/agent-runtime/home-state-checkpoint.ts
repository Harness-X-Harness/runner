import { spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A T3-only checkpoint worker is started in Restore, not in Serve.
 * It keeps the narrowly scoped store token while Serve runs. This is
 * deliberately documented as a longer same-UID exposure window.
 */
export const HOME_CHECKPOINT_INTERVAL_MS = 15 * 60 * 1000;
const CLI = fileURLToPath(new URL("./home-state-cli.ts", import.meta.url));

function runnerTemp(env: NodeJS.ProcessEnv): string {
  const dir = env.RUNNER_TEMP;
  if (!dir || !isAbsolute(dir)) throw new Error("INVALID_HOME_STATE");
  return dir;
}

export function checkpointPath(env: NodeJS.ProcessEnv, name: "lock" | "stop" | "pid" | "status"): string {
  return join(runnerTemp(env), "t3-home-checkpoint-" + name);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error("INVALID_HOME_STATE");
  if (!env.T3_RUNNER_STORE_REPOSITORY || !env.T3_RUNNER_STORE_TOKEN) {
    throw new Error("T3_RUNNER_STORE_TOKEN_REQUIRED");
  }
  // Do not pass Actions OIDC, job GITHUB_TOKEN or Agent work credentials.
  return {
    HOME: env.HOME,
    RUNNER_TEMP: runnerTemp(env),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    T3_RUNNER_STORE_REPOSITORY: env.T3_RUNNER_STORE_REPOSITORY,
    T3_RUNNER_STORE_TOKEN: env.T3_RUNNER_STORE_TOKEN,
  };
}

/** Started only after a completed restore. No checkpoint credential enters Serve. */
export async function startPeriodicCheckpoints(env: NodeJS.ProcessEnv): Promise<void> {
  if (!(await exists(join(runnerTemp(env), "t3-runner-home-restored")))) {
    throw new Error("T3_CHECKPOINT_RESTORE_REQUIRED");
  }
  if (await exists(checkpointPath(env, "pid"))) throw new Error("T3_CHECKPOINT_ALREADY_STARTED");
  await rm(checkpointPath(env, "stop"), { force: true });
  const child = spawn(process.execPath, [CLI, "checkpoint-worker"], {
    cwd: process.cwd(),
    env: workerEnvironment(env),
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("T3_CHECKPOINT_START_FAILED");
  child.unref();

  // Confirm the worker initialized; do not silently claim it started.
  for (let attempt = 0; attempt < 50; attempt++) {
    const pid = await readFile(checkpointPath(env, "pid"), "utf8").catch(() => "");
    if (pid.trim() === String(child.pid)) return;
    try { process.kill(child.pid, 0); }
    catch { throw new Error("T3_CHECKPOINT_START_FAILED"); }
    await delay(100);
  }
  try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
  throw new Error("T3_CHECKPOINT_START_FAILED");
}

/** Stop prevents new cycles; the final publish additionally takes the same flock. */
export async function stopPeriodicCheckpoints(env: NodeJS.ProcessEnv): Promise<void> {
  await writeFile(checkpointPath(env, "stop"), "stop\n", { mode: 0o600 });
  // A running checkpoint may still be committing; the final flock is the barrier.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await exists(checkpointPath(env, "pid")))) return;
    await delay(100);
  }
}

/**
 * Testable scheduler. Checkpoints are spaced from the end of the prior attempt;
 * failed attempts do not disable future checkpoints or clear the restore marker.
 */
export async function runCheckpointLoop(
  env: NodeJS.ProcessEnv,
  checkpoint: () => Promise<void>,
  intervalMs = HOME_CHECKPOINT_INTERVAL_MS,
): Promise<void> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("INVALID_CHECKPOINT_INTERVAL");
  const pidFile = checkpointPath(env, "pid");
  await writeFile(pidFile, String(process.pid) + "\n", { mode: 0o600 });
  try {
    while (!(await exists(checkpointPath(env, "stop")))) {
      const deadline = Date.now() + intervalMs;
      while (Date.now() < deadline && !(await exists(checkpointPath(env, "stop")))) {
        await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
      }
      if (await exists(checkpointPath(env, "stop"))) break;
      let state = "success";
      try { await checkpoint(); }
      catch { state = "failure"; }
      // Only a fixed status is written; native errors may contain credentials.
      await writeFile(checkpointPath(env, "status"),
        state + " " + new Date().toISOString() + "\n", { mode: 0o600 });
    }
  } finally {
    await rm(pidFile, { force: true });
  }
}

/** Each interval takes the same OS lock as the final teardown publish. */
async function checkpointOnceLocked(env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("flock",
      ["--exclusive", "--wait", "120", checkpointPath(env, "lock"),
        process.execPath, CLI, "checkpoint-once"],
      { env: workerEnvironment(env), stdio: "ignore" });
    child.once("error", () => reject(new Error("T3_CHECKPOINT_FAILED")));
    child.once("close", code => code === 0 ? resolve() : reject(new Error("T3_CHECKPOINT_FAILED")));
  });
}

export async function runCheckpointWorker(env: NodeJS.ProcessEnv): Promise<void> {
  await runCheckpointLoop(env, () => checkpointOnceLocked(env));
}
