import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { T3Connection, stopManagedProcess } from "./t3-connection.ts";
import { readT3Descriptor, type T3Descriptor } from "./t3-readiness.ts";

export type T3ServiceState =
  | { status: "starting" | "failed" | "stopped" }
  | { status: "ready"; origin: string };

export type T3ConnectionPort = Pick<T3Connection, "open" | "close"> &
  Partial<Pick<T3Connection, "subscribe">>;
export type T3ServiceOptions = {
  workspace: string;
  env: NodeJS.ProcessEnv;
  port?: number;
  executable?: string;
  args?: string[];
  launch?: typeof spawn;
  fetchImpl?: typeof fetch;
  remoteProbe?: (origin: string, signal: AbortSignal) => Promise<boolean>;
  connect?: (port: number, env: NodeJS.ProcessEnv) => T3ConnectionPort;
};

async function requireUnusedPort(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch { throw new Error("T3_PORT_UNAVAILABLE"); }
  finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
}

/**
 * An optional, unmodified T3 Code server owned by one Runner Environment.
 * The native T3 process remains alive across command/agent turns and is torn
 * down with the Environment, not with a direct command's process group.
 */
export class T3Service {
  private readonly options: T3ServiceOptions;
  private readonly port: number;
  private readonly watchers = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private child?: ChildProcess;
  private connection?: T3ConnectionPort;
  private started = false;
  private stopping = false;
  private serviceFailed = false;
  private current: T3ServiceState = { status: "starting" };
  private stopPromise?: Promise<void>;

  constructor(options: T3ServiceOptions) {
    this.options = options;
    this.port = options.port ?? 3773;
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535 ||
        !isAbsolute(options.workspace) ||
        !options.env.HOME || !isAbsolute(options.env.HOME)) throw new Error("INVALID_T3_SERVICE_OPTIONS");
  }

  read(): T3ServiceState { return { ...this.current }; }

  subscribe(changed: () => void): () => void {
    this.watchers.add(changed);
    return () => { this.watchers.delete(changed); };
  }

  private set(state: T3ServiceState): void {
    this.current = state;
    for (const changed of this.watchers) {
      try { changed(); } catch { /* Observation cannot change service lifetime. */ }
    }
  }

  private async remoteReady(origin: string, expected: T3Descriptor, signal: AbortSignal): Promise<boolean> {
    if (this.options.remoteProbe) return this.options.remoteProbe(origin, signal);
    const descriptor = await readT3Descriptor(origin, signal, this.options.fetchImpl);
    return descriptor !== null && descriptor.environmentId === expected.environmentId &&
      descriptor.serverVersion === expected.serverVersion;
  }

  async start(parentSignal: AbortSignal): Promise<void> {
    if (this.started) throw new Error("T3_ALREADY_STARTED");
    this.started = true;
    parentSignal.throwIfAborted();
    const abort = () => { void this.close().catch(() => {}); };
    parentSignal.addEventListener("abort", abort, { once: true });
    this.lifetime.signal.addEventListener("abort", () => parentSignal.removeEventListener("abort", abort), { once: true });
    const signal = AbortSignal.any([parentSignal, this.lifetime.signal, AbortSignal.timeout(90_000)]);
    try {
      await mkdir(this.options.workspace, { recursive: true, mode: 0o700 });
      await requireUnusedPort(this.port);
      signal.throwIfAborted();
      const executable = this.options.executable ?? join(this.options.env.HOME!, ".local", "bin", "t3");
      const args = this.options.args ?? [
        "serve", "--host", "127.0.0.1", "--port", String(this.port), this.options.workspace,
      ];
      const child = (this.options.launch ?? spawn)(executable, args,
        { detached: true, stdio: "ignore", env: this.options.env, cwd: this.options.workspace });
      this.child = child;
      let exited = false;
      child.once("error", () => {
        exited = true;
        if (!this.stopping) {
          this.serviceFailed = true;
          this.set({ status: "failed" });
          void this.close().catch(() => {});
        }
      });
      child.once("exit", () => {
        exited = true;
        if (!this.stopping) {
          this.serviceFailed = true;
          this.set({ status: "failed" });
          void this.close().catch(() => {});
        }
      });
      const fetchImpl = this.options.fetchImpl ?? fetch;
      let local: T3Descriptor | null = null;
      while (!signal.aborted && !exited) {
        local = await readT3Descriptor(`http://127.0.0.1:${this.port}`, signal, fetchImpl);
        if (local) break;
        await delay(250, undefined, { signal }).catch(() => {});
      }
      if (!local || exited || signal.aborted) throw new Error("T3_STARTUP_UNAVAILABLE");
      this.connection = (this.options.connect ?? ((port, env) => new T3Connection(port, env)))(
        this.port, this.options.env);
      this.connection.subscribe?.(() => {
        if (!this.stopping) {
          this.serviceFailed = true;
          this.set({ status: "failed" });
          void this.close().catch(() => {});
        }
      });
      const { origin } = await this.connection.open(signal);
      // A tunnel URL in cloudflared stderr does not prove public T3 reachability.
      let publicReady = false;
      const publicDeadline = Date.now() + 30_000;
      while (!signal.aborted && !exited && Date.now() < publicDeadline) {
        if (await this.remoteReady(origin, local, signal)) { publicReady = true; break; }
        await delay(500, undefined, { signal }).catch(() => {});
      }
      if (!publicReady || exited || signal.aborted) throw new Error("T3_STARTUP_UNAVAILABLE");
      this.set({ status: "ready", origin });
    } catch {
      await this.close();
      this.set({ status: "failed" });
      throw new Error("T3_STARTUP_UNAVAILABLE");
    }
  }

  /** Mint a native, short-lived owner pairing link; never log or publish it in MCP outputs. */
  async issuePairing(origin: string, signal: AbortSignal): Promise<string> {
    if (this.stopping || this.current.status !== "ready" || this.current.origin !== origin) {
      throw new Error("T3_PAIRING_UNAVAILABLE");
    }
    signal.throwIfAborted();
    const binary = this.options.executable ?? join(this.options.env.HOME!, ".local", "bin", "t3");
    const env: NodeJS.ProcessEnv = {
      HOME: this.options.env.HOME,
      ...(this.options.env.PATH ? { PATH: this.options.env.PATH } : {}),
      ...(this.options.env.TMPDIR ? { TMPDIR: this.options.env.TMPDIR } : {}),
    };
    try {
      const { stdout } = await execute(binary, [
        "auth", "pairing", "create", "--base-url", origin, "--ttl", "5m", "--json",
      ], { env, cwd: this.options.workspace, timeout: 12_000,
        signal: AbortSignal.any([signal, this.lifetime.signal]), maxBuffer: 8192 });
      if (this.stopping || this.current.status !== "ready" || this.current.origin !== origin) {
        throw new Error("T3_PAIRING_UNAVAILABLE");
      }
      const result: unknown = JSON.parse(stdout);
      if (typeof result !== "object" || result === null || !("pairUrl" in result) ||
          typeof result.pairUrl !== "string") throw new Error("T3_PAIRING_UNAVAILABLE");
      const url = new URL(result.pairUrl);
      if (url.origin !== origin || url.pathname !== "/pair" ||
          !url.hash.startsWith("#token=") || url.hash.length < 14 || url.search) {
        throw new Error("T3_PAIRING_UNAVAILABLE");
      }
      return url.toString();
    } catch {
      // Native CLI errors can contain secrets. Never propagate them.
      throw new Error("T3_PAIRING_UNAVAILABLE");
    }
  }

  close(): Promise<void> {
    return this.stopPromise ??= (async () => {
      this.stopping = true;
      this.lifetime.abort();
      try {
        try { await this.connection?.close(); }
        finally { await stopManagedProcess(this.child); }
        this.set({ status: this.serviceFailed ? "failed" : "stopped" });
      } catch {
        this.set({ status: "failed" });
        throw new Error("T3_PROCESS_STOP_FAILED");
      }
    })();
  }
}
