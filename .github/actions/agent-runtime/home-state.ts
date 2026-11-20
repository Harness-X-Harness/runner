import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export function homeStateRequested(env: NodeJS.ProcessEnv): boolean {
  return env.T3_RESTORE_HOME === "1";
}

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) throw new Error("INVALID_HOME_STATE");
  return home;
}

function storeRepository(env: NodeJS.ProcessEnv): string {
  const repository = env.T3_RESTORE_RUNNER_HOME?.trim() ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("T3_RESTORE_RUNNER_HOME_REQUIRED");
  return repository;
}

function storeUrl(env: NodeJS.ProcessEnv): string {
  return env.T3_RUNNER_STORE_URL ?? `https://github.com/${storeRepository(env)}.git`;
}

function authArgs(env: NodeJS.ProcessEnv): string[] {
  const url = storeUrl(env);
  if (!url.startsWith("https://")) return [];
  const token = env.T3_RUNNER_STORE_TOKEN;
  if (!token) throw new Error("T3_RUNNER_STORE_TOKEN_REQUIRED");
  return ["-c", `http.extraheader=AUTHORIZATION: bearer ${token}`];
}

function redact(text: string, env: NodeJS.ProcessEnv | undefined): string {
  let out = text;
  for (const secret of [env?.T3_RUNNER_STORE_TOKEN, env?.T3_RESTORE_RUNNER_HOME]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const env = options.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH, HOME: options.env?.HOME, GIT_TERMINAL_PROMPT: "0", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => reject(new Error(redact(error.message, env))));
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(redact(stderr.trim() || `${command} exited ${code}`, env)));
    });
  });
}

function archiveInto(repo: string, home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const git = spawn("git", ["-C", repo, "archive", "--format=tar", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-C", home, "-xf", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    git.stderr.on("data", chunk => { stderr += chunk; });
    tar.stderr.on("data", chunk => { stderr += chunk; });
    git.stdout.pipe(tar.stdin);
    git.on("error", reject);
    tar.on("error", reject);
    let gitCode: number | null = null;
    let tarCode: number | null = null;
    const finish = () => {
      if (gitCode === null || tarCode === null) return;
      if (gitCode === 0 && tarCode === 0) resolve();
      else reject(new Error(stderr.trim() || "T3_RUNNER_STORE_ARCHIVE_FAILED"));
    };
    git.on("close", code => { gitCode = code ?? 1; finish(); });
    tar.on("close", code => { tarCode = code ?? 1; finish(); });
  });
}

/** Overlay tracked store files onto HOME. Untracked installs stay in place. */
export async function restoreHomeState(env: NodeJS.ProcessEnv): Promise<void> {
  if (!homeStateRequested(env)) return;
  const home = homeOf(env);
  const staging = await mkdtemp(join(tmpdir(), "t3-runner-store-"));
  try {
    await run("git", [...authArgs(env), "clone", "--depth", "1", "--branch", "main", storeUrl(env), staging], { env });
    await archiveInto(staging, home);
    await rm(join(home, ".git"), { recursive: true, force: true });
    await run("mv", [join(staging, ".git"), join(home, ".git")]);
    await run("git", ["-C", home, "reset", "--mixed", "HEAD"], { env });
    if (await access(join(home, ".githooks", "pre-commit")).then(() => true, () => false)) {
      await run("git", ["-C", home, "config", "core.hooksPath", ".githooks"], { env });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Commit and push HOME when the store flag restored it. A clean tree is success. */
export async function publishHomeState(env: NodeJS.ProcessEnv): Promise<void> {
  if (!homeStateRequested(env)) return;
  const home = homeOf(env);
  const status = await run("git", ["-C", home, "status", "--porcelain"], { env });
  if (!status.trim()) return;
  await run("git", ["-C", home, "add", "-A"], { env });
  await run("git", ["-C", home, "-c", "user.name=t3-runner-store",
    "-c", "user.email=t3-runner-store@users.noreply.github.com",
    "commit", "-m", "Backup T3 state and provider sessions"], { env });
  await run("git", [...authArgs(env), "-C", home, "push", "origin", "HEAD:main"], { env });
}
