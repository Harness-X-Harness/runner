import { Worker, isMainThread, workerData } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withAcpAgent } from "./acp-client.ts";
import { configureProvider, agentEnvironment } from "./provider-config.ts";
import { providerProcess } from "./provider-process.ts";
import { EnvironmentRuntime } from "./environment-runtime.ts";
import { readExecutorReport } from "./agent-model.ts";

async function probe(executor: "codex" | "grok") {
  const env = agentEnvironment(process.env);
  delete env.GH_TOKEN;
  await configureProvider(executor, env);
  const workspace = await mkdtemp(path.join(tmpdir(), "harness-auth-"));
  const signal = AbortSignal.timeout(120000);
  const runtime = new EnvironmentRuntime({ workspace, env, deadline: Date.now() + 120000,
    readAgentReport: (provider, signal) => readExecutorReport(provider, env, fetch, signal) });
  try {
    await withAcpAgent({ ...providerProcess(executor, workspace, env), signal }, {
      sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    }, client => client.buildSession({ cwd: workspace, mcpServers: [] }).withSession(async session => {
      const result = await runtime.agent(client, session, executor, "Do not use tools. Reply exactly OK.");
      if (result.status !== "completed") throw new Error("AUTH_PROBE_INCOMPLETE");
    }));
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

// Both native streams and model output stay private, including failed probes.
if (!isMainThread) {
  probe(workerData).catch(() => { process.exitCode = 1; });
} else if (import.meta.main) {
  const executor = process.argv[2];
  if (executor !== "codex" && executor !== "grok") throw new Error("Invalid executor");
  const worker = new Worker(new URL(import.meta.url), { workerData: executor, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  worker.on("error", () => { process.exitCode = 1; });
  worker.on("exit", code => {
    process.exitCode = code;
    process.stdout.write(code === 0 ? "Native ACP authentication and default configuration passed.\n" : "Native ACP auth probe failed.\n");
  });
}
