import { execFile } from "node:child_process";

export type T3CliOptions = {
  binary?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal;
};

/** execFile errors contain argv/stdout/stderr. Never let one reach a reporter. */
export async function privateT3Command(args: string[], options: T3CliOptions = {}): Promise<{
  stdout: string; exitCode: number;
}> {
  return new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
    execFile(options.binary ?? process.env.T3_LIVE_BINARY ?? "t3", args, {
      cwd: options.cwd, env: options.env ?? {
        HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
        ...(process.env.T3CODE_HOME ? { T3CODE_HOME: process.env.T3CODE_HOME } : {}),
      }, timeout: options.timeoutMs ?? 20_000, signal: options.signal,
      killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8",
    }, (error, stdout) => {
      if (error && (typeof error.code !== "number" || error.killed)) {
        reject(new Error("T3_PRIVATE_CLI_FAILED"));
      } else resolve({ stdout, exitCode: error ? Number(error.code) : 0 });
    });
  });
}

export async function privateT3Json(args: string[], options: T3CliOptions = {}): Promise<{
  value: unknown; exitCode: number;
}> {
  const result = await privateT3Command(args, options);
  try { return { value: JSON.parse(result.stdout), exitCode: result.exitCode }; }
  catch { throw new Error("T3_PRIVATE_CLI_JSON_INVALID"); }
}

export function liveOrigin(value: string, mcp = false): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.search || url.hash ||
        url.pathname !== (mcp ? "/mcp" : "/")) throw new Error();
    return url.origin;
  } catch { throw new Error("T3_LIVE_ORIGIN_INVALID"); }
}

/** Native MCP credentials stay on the verified origin; even 307/308 redirects fail closed. */
export function t3McpFetch(origin: string): typeof fetch {
  return async (input, init) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin || url.username || url.password) throw new Error();
      return await fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000),
      ]) });
    } catch { throw new Error("T3_MCP_PRIVATE_FETCH_FAILED"); }
  };
}

export function requireTrustedModelContext(env: NodeJS.ProcessEnv): void {
  if (env.T3_LIVE_TRUSTED !== "1" || env.T3_LIVE_MODEL !== "1" || env.T3_LIVE !== "1" ||
      (env.GITHUB_EVENT_NAME ?? "").startsWith("pull_request")) {
    throw new Error("T3_LIVE_MODEL_TRUST_REQUIRED");
  }
  if (!["codex", "grok"].includes(env.T3_LIVE_PROVIDER ?? "") || !env.T3_LIVE_MODEL_ID?.trim() ||
      !env.T3_LIVE_PROJECT?.startsWith("/")) throw new Error("T3_LIVE_MODEL_SELECTION_REQUIRED");
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("T3_LIVE_JSON_SHAPE_INVALID");
  return value as Record<string, unknown>;
}

/** Check exact provider, run and authoritative terminal state without printing model text. */
export function verifyModelRun(result: unknown, state: unknown, provider: string, model: string, marker: string): void {
  const run = jsonObject(result);
  const shown = jsonObject(state);
  const thread = jsonObject(shown.thread);
  if (run.status !== "completed") {
    const status = ["failed", "cancelled", "interrupted", "waiting"].includes(String(run.status))
      ? String(run.status).toUpperCase() : "INVALID";
    throw new Error("T3_LIVE_RUN_" + status);
  }
  if (typeof run.threadId !== "string" || typeof run.runId !== "string" ||
      typeof run.reply !== "string" || run.reply.trim() !== marker ||
      thread.threadId !== run.threadId || thread.latestRunId !== run.runId ||
      thread.status !== "completed" || thread.activeRunId !== null || thread.pendingRequestCount !== 0 ||
      thread.providerInstanceId !== provider || thread.model !== model || !Array.isArray(shown.messages) ||
      !shown.messages.some(value => {
        const item = jsonObject(value);
        return item.role === "assistant" && item.runId === run.runId &&
          typeof item.text === "string" && item.text.trim() === marker;
      })) throw new Error("T3_LIVE_RUN_EVIDENCE_INVALID");
}
