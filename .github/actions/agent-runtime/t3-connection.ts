import { spawn, type ChildProcess } from "node:child_process";

export type T3PublicConnection = { origin: string };

type Spawn = typeof spawn;
const ORIGIN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![.a-z0-9-])/i;

/** Only a Cloudflare-issued HTTPS origin is exposed; never forward raw tunnel logs. */
export function t3PublicOrigin(text: string): string | null {
  const match = ORIGIN.exec(text);
  if (!match) return null;
  const url = new URL(match[0]);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) return null;
  return url.origin;
}

/** Terminate a managed process group and confirm exit before returning. */
export async function stopManagedProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("T3_PROCESS_STOP_FAILED");
    }
  } else child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const terminated = await Promise.race([exited.then(() => true), new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), 3000);
  })]);
  if (timer) clearTimeout(timer);
  if (!terminated) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("T3_PROCESS_STOP_FAILED");
      }
    } else child.kill("SIGKILL");
    await exited;
  }
}

/**
 * A fresh public tunnel is a transport, not an authentication bypass.
 * T3 owns browser pairing, OAuth MCP scopes, approvals and revocation.
 * Never generate or log pairing credentials in this service.
 */
export class T3Connection {
  private child?: ChildProcess;
  private closing = false;
  private readonly disconnected = new Set<() => void>();
  private readonly port: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly launch: Spawn;
  constructor(port: number, env: NodeJS.ProcessEnv, launch: Spawn = spawn) {
    this.port = port;
    this.env = env;
    this.launch = launch;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_T3_PORT");
  }

  subscribe(onDisconnect: () => void): () => void {
    this.disconnected.add(onDisconnect);
    return () => { this.disconnected.delete(onDisconnect); };
  }

  async open(signal: AbortSignal, timeoutMs = 45_000): Promise<T3PublicConnection> {
    if (this.child || this.closing) throw new Error("T3_CONNECTION_ALREADY_STARTED");
    signal.throwIfAborted();
    // Never forward model or GitHub work credentials to an unrelated tunnel binary.
    const transportEnv: NodeJS.ProcessEnv = {
      ...(this.env.PATH ? { PATH: this.env.PATH } : {}),
      ...(this.env.HOME ? { HOME: this.env.HOME } : {}),
      ...(this.env.TMPDIR ? { TMPDIR: this.env.TMPDIR } : {}),
    };
    const child = this.launch("cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`],
      { env: transportEnv, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    const disconnected = () => {
      if (!this.closing) for (const callback of this.disconnected) {
        try { callback(); } catch { /* Observers do not own transport lifetime. */ }
      }
    };
    child.on("error", disconnected);
    child.once("exit", disconnected);
    let buffer = "";
    let settled = false;
    try {
      return await new Promise<T3PublicConnection>((resolve, reject) => {
        const finish = (origin?: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (origin) resolve({ origin });
          else reject(new Error("T3_CONNECTION_UNAVAILABLE"));
        };
        const output = (chunk: Buffer | string) => {
          // Bounded private buffer: tunnel output can contain operational data.
          buffer = (buffer + chunk.toString()).slice(-4096);
          const origin = t3PublicOrigin(buffer);
          if (origin) finish(origin);
        };
        const abort = () => finish();
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          child.stderr?.off("data", output);
          child.off("error", abort);
          child.off("exit", abort);
        };
        const timer = setTimeout(abort, timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        child.stderr?.on("data", output);
        child.once("error", abort);
        child.once("exit", abort);
        if (signal.aborted) finish();
      });
    } catch {
      await this.close();
      throw new Error("T3_CONNECTION_UNAVAILABLE");
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await stopManagedProcess(this.child);
  }
}
