import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Tests use a local bare repository; production always uses the repository secret. */
export type HomeStateOptions = { repositoryUrl?: string; retainRestoreMarker?: boolean };

function requiredDirectory(value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error("INVALID_HOME_STATE");
  return value;
}

function markerOf(env: NodeJS.ProcessEnv): string {
  return join(requiredDirectory(env.RUNNER_TEMP), "t3-runner-home-restored");
}

function storeUrl(env: NodeJS.ProcessEnv, options: HomeStateOptions): string {
  if (options.repositoryUrl !== undefined) return options.repositoryUrl;
  const repo = env.T3_RUNNER_STORE_REPOSITORY?.trim() ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("T3_RUNNER_STORE_REPOSITORY_REQUIRED");
  return `https://github.com/${repo}.git`;
}

function authEnvironment(env: NodeJS.ProcessEnv, options: HomeStateOptions): NodeJS.ProcessEnv {
  if (options.repositoryUrl !== undefined) return {};
  if (!env.T3_RUNNER_STORE_TOKEN) throw new Error("T3_RUNNER_STORE_TOKEN_REQUIRED");
  // GitHub HTTPS Git uses PAT-as-password Basic auth. Keep it out of argv and .git/config.
  const credential = Buffer.from(`x-access-token:${env.T3_RUNNER_STORE_TOKEN}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
  };
}

/** Do not inherit workflow credentials or user-controlled Git configuration. */
function processEnvironment(home: string, gitAuth: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
    ...gitAuth,
  };
}

async function run(command: string, args: string[], home: string, errorCode: string,
  options: { stdin?: string; accepted?: number[]; gitAuth?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: processEnvironment(home, options.gitAuth),
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    // Git may include a private repository or the credential header in errors.
    child.stderr!.resume();
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);
    child.once("error", () => reject(new Error(errorCode)));
    child.once("close", code => {
      if (code === 0 || (code !== null && options.accepted?.includes(code))) resolve(stdout);
      else reject(new Error(errorCode));
    });
  });
}

async function cloneStore(env: NodeJS.ProcessEnv, options: HomeStateOptions, home: string,
  staging: string): Promise<void> {
  const url = storeUrl(env, options);
  await run("git", ["clone", "--depth", "1", "--branch", "main", url, staging],
    home, "T3_RUNNER_STORE_CLONE_FAILED", { gitAuth: authEnvironment(env, options) });
}

/** Refuse link entries that could redirect archived HOME files outside HOME. */
async function verifyArchive(repo: string, home: string): Promise<void> {
  const listing = await run("git", ["-C", repo, "ls-tree", "-r", "-z", "HEAD"], home,
    "T3_RUNNER_STORE_TREE_FAILED");
  if (listing.split("\0").some(line => line.startsWith("120000 ") || line.startsWith("160000 "))) {
    throw new Error("T3_RUNNER_STORE_LINK_NOT_ALLOWED");
  }
}

async function archiveInto(repo: string, home: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const git = spawn("git", ["-C", repo, "archive", "--format=tar", "HEAD"],
      { env: processEnvironment(home), stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-C", home, "-xf", "-"],
      { env: processEnvironment(home), stdio: ["pipe", "ignore", "pipe"] });
    git.stderr.resume();
    tar.stderr.resume();
    git.stdout.pipe(tar.stdin);
    tar.stdin.on("error", () => {});
    git.once("error", () => reject(new Error("T3_RUNNER_STORE_ARCHIVE_FAILED")));
    tar.once("error", () => reject(new Error("T3_RUNNER_STORE_ARCHIVE_FAILED")));
    let gitCode: number | null = null;
    let tarCode: number | null = null;
    const finish = () => {
      if (gitCode === null || tarCode === null) return;
      if (gitCode === 0 && tarCode === 0) resolve();
      else reject(new Error("T3_RUNNER_STORE_ARCHIVE_FAILED"));
    };
    git.once("close", code => { gitCode = code ?? 1; finish(); });
    tar.once("close", code => { tarCode = code ?? 1; finish(); });
  });
}

/** Run in a short-lived workflow step, after T3 browser setup and before serve. */
export async function restoreHomeState(env: NodeJS.ProcessEnv, options: HomeStateOptions = {}): Promise<void> {
  const home = requiredDirectory(env.HOME);
  const marker = markerOf(env);
  await rm(marker, { force: true });
  const staging = await mkdtemp(join(tmpdir(), "t3-home-restore-"));
  try {
    await cloneStore(env, options, home, staging);
    await verifyArchive(staging, home);
    await archiveInto(staging, home);
    // No .git directory or backup credential is put in the T3 HOME.
    await writeFile(marker, "restored\n", { mode: 0o600 });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Stage against a fresh, trusted clone; never execute a HOME-provided hook. */
async function stageHome(repo: string, home: string): Promise<string[]> {
  const canonicalIgnore = await readFile(join(repo, ".gitignore"));
  const ignoreInfo = await lstat(join(home, ".gitignore"));
  if (!ignoreInfo.isFile()) throw new Error("T3_RUNNER_STORE_IGNORE_CHANGED");
  const actualIgnore = await readFile(join(home, ".gitignore"));
  if (!canonicalIgnore.equals(actualIgnore)) throw new Error("T3_RUNNER_STORE_IGNORE_CHANGED");
  const git = ["--git-dir", join(repo, ".git"), "--work-tree", home];
  await run("git", [...git, "add", "-A"], home, "T3_RUNNER_STORE_STAGE_FAILED");
  const staged = await run("git", [...git, "diff", "--cached", "--name-only", "-z"], home,
    "T3_RUNNER_STORE_DIFF_FAILED");
  // Nested .gitignore files in HOME cannot override the canonical store selection.
  if (staged) {
    const ignored = await run("git", ["-C", repo, "check-ignore", "--no-index", "--stdin", "-z"],
      home, "T3_RUNNER_STORE_IGNORE_CHECK_FAILED", { stdin: staged, accepted: [1] });
    if (ignored) throw new Error("T3_RUNNER_STORE_IGNORED_PATH");
  }
  const listed = await run("git", [...git, "ls-files", "--cached", "-z"], home,
    "T3_RUNNER_STORE_INDEX_FAILED");
  return listed.split("\0").filter(Boolean);
}

/** SQLite WAL transactions may not have touched the main database file yet. */
async function snapshotDatabases(repo: string, home: string, paths: string[]): Promise<void> {
  const git = ["--git-dir", join(repo, ".git"), "--work-tree", home];
  for (const file of paths) {
    if (!/\.(?:db|sqlite)$/i.test(file)) continue;
    const absolute = join(home, file);
    const info = await lstat(absolute).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!info) continue; // Deleted database; the staged deletion remains.
    if (!info.isFile()) throw new Error("T3_RUNNER_STORE_DATABASE_NOT_REGULAR");
    if (info.size === 0) continue;
    const snapshotDir = await mkdtemp(join(tmpdir(), "t3-home-sqlite-"));
    try {
      const snapshot = join(snapshotDir, "snapshot.sqlite");
      const sqliteCommand = `.backup '${snapshot.replaceAll("'", "''")}'`;
      await run("sqlite3", ["-batch", "-cmd", ".timeout 5000", absolute, sqliteCommand], home,
        "T3_RUNNER_STORE_SQLITE_BACKUP_FAILED");
      const blob = (await run("git", [...git, "hash-object", "-w", snapshot], home,
        "T3_RUNNER_STORE_BLOB_FAILED")).trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error("T3_RUNNER_STORE_BLOB_FAILED");
      await run("git", [...git, "update-index", "--cacheinfo", "100644", blob, file], home,
        "T3_RUNNER_STORE_INDEX_FAILED");
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  }
}

/** One publisher runs after serve exits; retries cannot mistake a clean tree for a pushed commit. */
export async function publishHomeState(env: NodeJS.ProcessEnv, options: HomeStateOptions = {}): Promise<void> {
  const home = requiredDirectory(env.HOME);
  const marker = markerOf(env);
  if (!(await access(marker).then(() => true, () => false))) return;
  const staging = await mkdtemp(join(tmpdir(), "t3-home-publish-"));
  try {
    await cloneStore(env, options, home, staging);
    const paths = await stageHome(staging, home);
    await snapshotDatabases(staging, home, paths);
    const git = ["--git-dir", join(staging, ".git"), "--work-tree", home];
    const staged = await run("git", [...git, "diff", "--cached", "--name-only", "-z"], home,
      "T3_RUNNER_STORE_DIFF_FAILED");
    if (staged) {
      await run("git", [...git, "-c", "core.hooksPath=/dev/null", "-c", "user.name=t3-runner-store",
        "-c", "user.email=t3-runner-store@users.noreply.github.com",
        "commit", "-m", "Backup T3 state and provider sessions"], home,
      "T3_RUNNER_STORE_COMMIT_FAILED");
      const pushArgs = [...git, "push", storeUrl(env, options), "HEAD:main"];
      let pushed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await run("git", pushArgs, home, "T3_RUNNER_STORE_PUSH_FAILED",
            { gitAuth: authEnvironment(env, options) });
          pushed = true;
          break;
        } catch {
          if (attempt === 2) throw new Error("T3_RUNNER_STORE_PUSH_FAILED");
        }
      }
      if (!pushed) throw new Error("T3_RUNNER_STORE_PUSH_FAILED");
    }
    if (!options.retainRestoreMarker) await rm(marker, { force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
