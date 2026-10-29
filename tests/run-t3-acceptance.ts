/** Explicit local/trusted acceptance entrypoint. Never invoke with secrets from PR CI. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { spawn, execFile, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { T3Service } from "../.github/actions/agent-runtime/t3-service.ts";
import { T3Connection, stopManagedProcess } from "../.github/actions/agent-runtime/t3-connection.ts";
import { configureProvider } from "../.github/actions/agent-runtime/provider-config.ts";
import { t3ProviderEnvironment } from "../.github/actions/agent-runtime/t3-provider.ts";
import { privateT3Command, requireTrustedModelContext } from "./helpers/t3-live.ts";
import { enableDisposableT3Provider } from "./helpers/t3-live-provider.ts";

const execute = promisify(execFile);

async function privateTest(file: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  children: ReturnType<typeof spawn>[]): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], {
    env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let failed = false;
  // Register immediately, including spawn errors. Never retain private stderr.
  child.on("error", () => { failed = true; });
  child.stdout!.on("data", chunk => { if (output.length < 1024 * 1024) output += String(chunk); else failed = true; });
  child.stderr!.resume();
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  const stopped = Promise.withResolvers<never>();
  const stop = () => {
    failed = true;
    void stopManagedProcess(child).then(
      () => stopped.reject(new Error("T3_ACCEPTANCE_PRIVATE_TEST_STOPPED")),
      () => stopped.reject(new Error("T3_ACCEPTANCE_PROCESS_STOP_FAILED")),
    );
  };
  const timer = setTimeout(stop, 210_000);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const code = await Promise.race([exited, stopped.promise]);
    if (code !== 0 || failed) throw new Error("T3_ACCEPTANCE_PRIVATE_TEST_FAILED");
    return output;
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop);
    await stopManagedProcess(child);
  }
}

async function main(): Promise<void> {
  if (process.env.T3_ACCEPTANCE !== "1") throw new Error("T3_ACCEPTANCE_OPT_IN_REQUIRED");
  const binary = process.env.T3_LIVE_BINARY;
  if (!binary || !isAbsolute(binary)) throw new Error("T3_ACCEPTANCE_ABSOLUTE_BINARY_REQUIRED");
  const model = process.env.T3_LIVE_MODEL === "1";
  const expectedVersion = process.env.T3_ACCEPTANCE_VERSION ?? "0.1.5";
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(expectedVersion)) throw new Error("T3_ACCEPTANCE_VERSION_INVALID");
  // Check before creating resources or passing a provider credential anywhere.
  if (model) requireTrustedModelContext({ ...process.env, T3_LIVE: "1", T3_LIVE_PROJECT: "/disposable" });
  const root = await mkdtemp(join(tmpdir(), "runner-t3-acceptance-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const children: ReturnType<typeof spawn>[] = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
  let service: T3Service | undefined;
  let failed = false;
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(project, { mode: 0o700 });
    const cliEnv = { HOME: home, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    await execute("git", ["init", "-q", project], { env: cliEnv, signal });
    const version = await privateT3Command(["--version"], { binary, env: cliEnv, signal });
    if (version.exitCode !== 0 || version.stdout.trim() !== "t3 v" + expectedVersion) {
      throw new Error("T3_ACCEPTANCE_VERSION_MISMATCH");
    }
    let env: NodeJS.ProcessEnv = cliEnv;
    if (model) {
      const provider = process.env.T3_LIVE_PROVIDER as "codex" | "grok";
      const source = { ...process.env, HOME: home };
      await configureProvider(provider, source);
      env = t3ProviderEnvironment(provider, source);
      // No GitHub authority is needed for a disposable inference probe.
      delete env.GH_TOKEN;
    }
    // Fixed native CLI port: fail closed on contention rather than talking to
    // an unrelated existing server. Real remote mode uses Quick Tunnel.
    const remote = process.env.T3_ACCEPTANCE_REMOTE === "1";
    const launch = ((command: string, args: string[], options: SpawnOptions) => {
      const child = spawn(command, args, options); children.push(child); return child;
    }) as unknown as typeof spawn;
    service = new T3Service({ workspace: project, env, executable: binary,
      launch,
      ...(remote ? { connect: (port: number, environment: NodeJS.ProcessEnv) => new T3Connection(port, environment, launch) }
        : { connect: () => ({
        open: async () => ({ origin: "http://127.0.0.1:3773" }), close: async () => {},
      }) }),
    });
    await service.start(signal);
    const ready = service.read();
    if (ready.status !== "ready") throw new Error("T3_ACCEPTANCE_NOT_READY");
    if (model) {
      await enableDisposableT3Provider(process.env.T3_LIVE_PROVIDER as "codex" | "grok",
        process.env.T3_LIVE_MODEL_ID!, { binary, env: cliEnv, signal });
    }
    const added = await privateT3Command(["project", "add", project], { binary, env: cliEnv, signal });
    if (added.exitCode !== 0) throw new Error("T3_ACCEPTANCE_PROJECT_FAILED");
    console.log("T3 v" + expectedVersion + " " + (remote ? "public HTTPS" : "loopback") + " readiness: passed");
    const testEnv: NodeJS.ProcessEnv = { ...cliEnv,
      T3_LIVE_BINARY: binary, T3_LIVE: "1", T3_LOCAL_ORIGIN: "http://127.0.0.1:3773",
      T3_LIVE_ORIGIN: ready.origin, T3_MCP_URL: ready.origin + "/mcp", T3_MCP_LIVE: "1",
      T3_LIVE_PROJECT: project,
      ...(model ? { T3_LIVE_MODEL: "1", T3_LIVE_TRUSTED: "1",
        T3_LIVE_PROVIDER: process.env.T3_LIVE_PROVIDER, T3_LIVE_MODEL_ID: process.env.T3_LIVE_MODEL_ID } : {}),
    };
    // Test stdout/stderr is captured, never forwarded: third-party errors may
    // contain credentials. Only fixed stage names/outcomes leave this process.
    let livePassed = false;
    for (const file of ["t3-live.test.ts", "t3-mcp.test.ts"]) {
      let passed = true;
      const expectedPassed = file === "t3-live.test.ts" && model ? 2 : 1;
      const expectedSkipped = file === "t3-live.test.ts" && !model ? 1 : 0;
      try {
        const result = await privateTest(fileURLToPath(new URL(file, import.meta.url)), testEnv, signal, children);
        if (Number(/^# pass (\d+)$/m.exec(result)?.[1]) !== expectedPassed ||
            Number(/^# skipped (\d+)$/m.exec(result)?.[1]) !== expectedSkipped) passed = false;
      } catch { passed = false; failed = true; }
      if (!passed) failed = true;
      if (file === "t3-live.test.ts") livePassed = passed;
      console.log(file + ": " + (passed ? `${expectedPassed} passed, ${expectedSkipped} skipped`
        : "FAILED (private diagnostics suppressed)"));
      if (signal.aborted) break;
    }
    console.log("Provider inference: " + (model ? process.env.T3_LIVE_PROVIDER + ": " + (livePassed ? "passed" : "FAILED")
      : "SKIPPED (no model opt-in)"));
    console.log("Owner browser / deployed Environment acceptance: UNVALIDATED (separate gates)");
  } finally {
    try {
      try { await service?.close(); }
      finally {
        const stops = await Promise.allSettled(children.map(child => stopManagedProcess(child)));
        if (stops.some(result => result.status === "rejected")) throw new Error("T3_ACCEPTANCE_PROCESS_STOP_FAILED");
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) throw new Error("T3_ACCEPTANCE_PROCESS_SURVIVED");
      }
      if (service && children.length) {
        let reachable = false;
        try { const response = await fetch("http://127.0.0.1:3773/", { signal: AbortSignal.timeout(2000) });
          await response.body?.cancel(); reachable = true;
        } catch { /* Expected once the disposable service exits. */ }
        if (reachable) throw new Error("T3_ACCEPTANCE_LISTENER_SURVIVED");
        console.log("Managed service close and listener cleanup: passed");
      }
    } finally {
      process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      await rm(root, { recursive: true, force: true });
    }
  }
  if (failed) throw new Error("T3_ACCEPTANCE_TESTS_FAILED");
}

if (import.meta.main) main().catch(error => {
  // Only locally defined fixed codes are eligible for public output.
  const codes = new Set(["T3_ACCEPTANCE_OPT_IN_REQUIRED", "T3_ACCEPTANCE_ABSOLUTE_BINARY_REQUIRED",
    "T3_ACCEPTANCE_VERSION_INVALID", "T3_ACCEPTANCE_VERSION_MISMATCH", "T3_ACCEPTANCE_NOT_READY", "T3_ACCEPTANCE_TESTS_FAILED",
    "T3_ACCEPTANCE_PROCESS_SURVIVED", "T3_ACCEPTANCE_LISTENER_SURVIVED", "T3_LIVE_MODEL_TRUST_REQUIRED",
    "T3_LIVE_MODEL_SELECTION_REQUIRED", "T3_STARTUP_UNAVAILABLE"]);
  console.error(error instanceof Error && codes.has(error.message) ? error.message : "T3_ACCEPTANCE_FAILED");
  process.exitCode = 1;
});
