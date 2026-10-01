import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { superviseEnvironmentWorker } from "../environment-entry.ts";
import { withEnvironment } from "../environment.ts";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { workerData: process.argv[2], stdout: true, stderr: true });
  worker.on("message", message => { if (message === "ready") process.emit("SIGTERM"); });
  try {
    await superviseEnvironmentWorker(worker);
    console.log(JSON.stringify(process.argv[2] === "stop" ? { stopped: true } : { completed: true }));
  } catch (error) { console.log(JSON.stringify({ error: (error as Error).message })); }
} else {
  const abort = new AbortController();
  parentPort!.on("message", () => abort.abort());
  try {
    if (workerData === "diagnostic") {
      console.log("PRIVATE_FIXTURE_MARKER"); console.error("PRIVATE_FIXTURE_MARKER");
      parentPort!.postMessage({ event: "environment_reconnect_failure", category: "runner_identity", observedAt: 1 });
      parentPort!.postMessage({ event: "environment_reconnect_failure", category: "transport_closed", observedAt: 2,
        closeCode: 1001 });
      for (const closeCode of [-1, 5000, 1001.5, "PRIVATE_FIXTURE_MARKER"]) {
        parentPort!.postMessage({ event: "environment_reconnect_failure", category: "transport_closed", observedAt: 2,
          closeCode });
      }
      parentPort!.postMessage({ event: "environment_reconnect_failure", category: "PRIVATE_FIXTURE_MARKER", observedAt: 1 });
      parentPort!.postMessage({ event: "environment_reconnect_failure", category: "transport_closed", observedAt: 1,
        error: "PRIVATE_FIXTURE_MARKER" });
    } else await withEnvironment({ command: workerData === "missing" ? "/missing-agent" : process.execPath,
      args: [fileURLToPath(new URL("./agent.ts", import.meta.url))], workspace: process.cwd(), env: {} },
    "codex", Date.now() + 5000, {}, {
      sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    }, async environment => {
      console.log("PRIVATE_FIXTURE_MARKER"); console.error("PRIVATE_FIXTURE_MARKER");
      if (workerData === "stop") {
        parentPort!.postMessage("ready");
        await new Promise<void>(resolve => environment.signal.addEventListener("abort", () => resolve(), { once: true }));
      } else await environment.agent(workerData);
    }, abort.signal);
  } catch { process.exitCode = 1; }
  finally { parentPort!.close(); }
}
