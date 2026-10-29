import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { T3Connection, stopManagedProcess } from "./t3-connection.ts";

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
  private connectionFailed = false;
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
        if (!this.stopping) this.set({ status: "failed" });
      });
      child.once("exit", () => {
        exited = true;
        if (!this.stopping) {
          this.set({ status: "failed" });
          void this.connection?.close().catch(() => {});
        }
      });
      const fetchImpl = this.options.fetchImpl ?? fetch;
      let healthy = false;
      while (!signal.aborted && !exited) {
        try {
          const response = await fetchImpl(`http://127.0.0.1:${this.port}/`, {
            redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
          });
          if (response.ok) { await response.body?.cancel(); healthy = true; break; }
        } catch { /* T3 is still starting. */ }
        await delay(250, undefined, { signal }).catch(() => {});
      }
      if (!healthy || exited) throw new Error("T3_STARTUP_UNAVAILABLE");
      this.connection = (this.options.connect ?? ((port, env) => new T3Connection(port, env)))(
        this.port, this.options.env);
      this.connection.subscribe?.(() => {
        if (!this.stopping) {
          this.connectionFailed = true;
          this.set({ status: "failed" });
          void this.close().catch(() => {});
        }
      });
      const { origin } = await this.connection.open(signal);
      if (exited || signal.aborted) throw new Error("T3_STARTUP_UNAVAILABLE");
      this.set({ status: "ready", origin });
    } catch {
      await this.close();
      this.set({ status: "failed" });
      throw new Error("T3_STARTUP_UNAVAILABLE");
    }
  }

  close(): Promise<void> {
    return this.stopPromise ??= (async () => {
      this.stopping = true;
      this.lifetime.abort();
      try {
        await this.connection?.close();
      } finally {
        await stopManagedProcess(this.child);
        this.set({ status: this.connectionFailed ? "failed" : "stopped" });
      }
    })();
  }
}
