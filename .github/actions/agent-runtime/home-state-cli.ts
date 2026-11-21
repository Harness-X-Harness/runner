import { publishHomeState, restoreHomeState } from "./home-state.ts";
import { runCheckpointWorker, startPeriodicCheckpoints, stopPeriodicCheckpoints } from "./home-state-checkpoint.ts";

// Keep restored session files private to the runner user.
process.umask(0o077);

try {
  if (process.argv[2] === "restore") await restoreHomeState(process.env);
  else if (process.argv[2] === "publish") await publishHomeState(process.env);
  else if (process.argv[2] === "checkpoint-once") await publishHomeState(process.env, { retainRestoreMarker: true });
  else if (process.argv[2] === "checkpoint-start") await startPeriodicCheckpoints(process.env);
  else if (process.argv[2] === "checkpoint-worker") await runCheckpointWorker(process.env);
  else if (process.argv[2] === "checkpoint-stop") await stopPeriodicCheckpoints(process.env);
  else throw new Error("INVALID_HOME_STATE_COMMAND");
} catch (error) {
  const message = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "T3_RUNNER_STORE_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
