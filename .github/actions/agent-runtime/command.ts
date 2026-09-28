import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type CommandInput = { argv: [string, ...string[]]; cwd?: string; timeoutSeconds: number };
export type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  stopReason?: "cancelled" | "timeout";
};
export type CommandContext = {
  workspace: string;
  // Supplied by the Environment owner from the actual remaining job budget.
  deadline: number;
  env: Partial<Pick<NodeJS.ProcessEnv, "PATH" | "HOME" | "TMPDIR" | "GH_TOKEN">>;
  signal: AbortSignal;
  onOutput?: (text: string, truncated?: boolean) => void;
};

const outputBytes = 64 * 1024;
const inputBytes = 64 * 1024;

export class CommandCleanupError extends Error {
  constructor() { super("COMMAND_CLEANUP_UNCONFIRMED"); }
}

// This is a working-directory boundary, not a file or process sandbox.
export async function runCommand(input: CommandInput, context: CommandContext): Promise<CommandResult> {
  if (process.platform === "win32" || !isAbsolute(context.workspace) ||
      !Array.isArray(input.argv) || !input.argv.length || !input.argv[0] ||
      input.argv.some(value => typeof value !== "string" || value.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(input)) > inputBytes ||
      !Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0 ||
      !Number.isFinite(context.deadline)) throw new Error("INVALID_COMMAND_INPUT");
  const workspace = await realpath(context.workspace);
  const cwd = await realpath(resolve(workspace, input.cwd ?? "."));
  const path = relative(workspace, cwd);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("COMMAND_CWD_OUTSIDE_WORKSPACE");
  }
  const duration = Math.min(context.deadline - Date.now(), input.timeoutSeconds * 1000);
  if (context.signal.aborted) throw new Error("COMMAND_CANCELLED_BEFORE_START");
  if (duration <= 0 || duration > 2_147_483_647) throw new Error("COMMAND_DEADLINE_EXPIRED");

  // Explicit projection: neither provider nor job/control credentials are inherited.
  const { PATH, HOME, TMPDIR, GH_TOKEN } = context.env;
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd, env: { PATH, HOME, TMPDIR, GH_TOKEN }, shell: false,
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((accept, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remaining = outputBytes;
    let truncated = false;
    let failed = false;
    let cleanupFailed = false;
    let stopReason: CommandResult["stopReason"];
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const capture = (target: Buffer[], decoder: StringDecoder) => (chunk: Buffer) => {
      const length = Math.min(remaining, chunk.length);
      if (length) target.push(Buffer.from(chunk.subarray(0, length)));
      remaining -= length;
      truncated ||= length < chunk.length;
      context.onOutput?.(decoder.write(chunk.subarray(0, length)), length < chunk.length);
    };
    const stopGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") cleanupFailed = true;
      }
    };
    const stop = (reason: NonNullable<CommandResult["stopReason"]>) => {
      stopReason ??= reason;
      stopGroup();
    };
    const cancel = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), duration);
    child.stdout.on("data", capture(stdout, decoders[0]!));
    child.stderr.on("data", capture(stderr, decoders[1]!));
    child.on("error", () => { failed = true; });
    // No background-process API: stop descendants still in this command's group.
    // A process deliberately escaping the group requires Environment teardown.
    child.on("exit", stopGroup);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
      for (const decoder of decoders) context.onOutput?.(decoder.end(), truncated);
      if (cleanupFailed) return reject(new CommandCleanupError());
      if (failed) return reject(new Error("COMMAND_EXECUTION_FAILED"));
      // Invalid byte sequences may expand when decoded to replacement characters.
      // Bound the returned UTF-8 text as well as the captured raw bytes.
      let textRemaining = outputBytes;
      const text = (chunks: Buffer[]) => {
        const bytes = Buffer.from(Buffer.concat(chunks).toString("utf8"));
        truncated ||= bytes.length > textRemaining;
        const value = new TextDecoder().decode(bytes.subarray(0, textRemaining), { stream: true });
        textRemaining -= Buffer.byteLength(value);
        return value;
      };
      const output = { stdout: text(stdout), stderr: text(stderr) };
      accept({ exitCode, signal, ...output, truncated,
        ...(stopReason ? { stopReason } : {}),
      });
    });
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
  });
}
