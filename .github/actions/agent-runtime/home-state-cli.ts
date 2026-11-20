import { publishHomeState, restoreHomeState } from "./home-state.ts";

// Keep restored session files private to the runner user.
process.umask(0o077);

try {
  if (process.argv[2] === "restore") await restoreHomeState(process.env);
  else if (process.argv[2] === "publish") await publishHomeState(process.env);
  else throw new Error("INVALID_HOME_STATE_COMMAND");
} catch (error) {
  const message = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "T3_RUNNER_STORE_FAILED";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
