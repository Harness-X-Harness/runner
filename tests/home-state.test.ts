import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { restoreHomeState, publishHomeState } from "../.github/actions/agent-runtime/home-state.ts";
import { checkpointPath, runCheckpointLoop, HOME_CHECKPOINT_INTERVAL_MS } from
  "../.github/actions/agent-runtime/home-state-checkpoint.ts";

const execute = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd, env: { ...process.env,
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
  return stdout;
}

async function fixture(extraIgnore = ""): Promise<{
  root: string; work: string; bare: string; home: string; env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "home-state-"));
  const work = join(root, "work");
  const bare = join(root, "store.git");
  const home = join(root, "home");
  const runnerTemp = join(root, "runner-temp");
  await Promise.all([mkdir(work), mkdir(home), mkdir(runnerTemp)]);
  await git(work, ["init", "-b", "main"]);
  await mkdir(join(work, ".githooks"));
  await writeFile(join(work, ".gitignore"), `*\n!.gitignore\n!.githooks/\n!.githooks/**\n!keep.txt\n!new-session.txt\n${extraIgnore}`);
  await writeFile(join(work, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  await chmod(join(work, ".githooks", "pre-commit"), 0o755);
  await writeFile(join(work, "keep.txt"), "from-store\n");
  await writeFile(join(work, "private-untracked.txt"), "must-not-back-up\n");
  await git(work, ["add", ".gitignore", ".githooks/pre-commit", "keep.txt"]);
  await git(work, ["commit", "-m", "initial"]);
  await execute("git", ["init", "--bare", "-b", "main", bare]);
  await git(work, ["remote", "add", "origin", bare]);
  await git(work, ["push", "origin", "HEAD:main"]);
  const env: NodeJS.ProcessEnv = { HOME: home, RUNNER_TEMP: runnerTemp,
    T3_RUNNER_STORE_TOKEN: "PRIVATE_STORE_TOKEN_NOT_FOR_HOOKS" };
  return { root, work, bare, home, env };
}

const opts = (bare: string) => ({ repositoryUrl: bare });

test("restore overlays tracked files; publish includes selected new files and is idempotent", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "keep.txt"), "old\n");
    await writeFile(join(f.home, "installed-binary"), "stay\n");
    await restoreHomeState(f.env, opts(f.bare));
    assert.equal(await readFile(join(f.home, "keep.txt"), "utf8"), "from-store\n");
    assert.equal(await readFile(join(f.home, "installed-binary"), "utf8"), "stay\n");
    await assert.rejects(access(join(f.home, ".git")));
    await writeFile(join(f.home, "keep.txt"), "after-run\n");
    await writeFile(join(f.home, "new-session.txt"), "session\n");
    await publishHomeState(f.env, opts(f.bare));
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "after-run\n");
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:new-session.txt"]), "session\n");
    const tracked = await git(f.work, ["--git-dir", f.bare, "ls-tree", "-r", "--name-only", "main"]);
    assert.doesNotMatch(tracked, /installed-binary|private-untracked.txt/);
    const tip = (await git(f.work, ["--git-dir", f.bare, "rev-parse", "main"])).trim();
    await publishHomeState(f.env, opts(f.bare));
    assert.equal((await git(f.work, ["--git-dir", f.bare, "rev-parse", "main"])).trim(), tip);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a changed HOME hook never executes with backup credentials", async () => {
  const f = await fixture();
  try {
    await restoreHomeState(f.env, opts(f.bare));
    const signal = join(f.root, "hook-signal");
    await writeFile(join(f.home, ".githooks", "pre-commit"), `#!/bin/sh\nprintf '%s' "$T3_RUNNER_STORE_TOKEN" > '${signal}'\nexit 9\n`);
    await chmod(join(f.home, ".githooks", "pre-commit"), 0o755);
    await writeFile(join(f.home, "keep.txt"), "safe\n");
    await publishHomeState(f.env, opts(f.bare));
    await assert.rejects(access(signal));
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "safe\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("publisher retries a failed push instead of confusing clean tree with successful backup", async () => {
  const f = await fixture();
  try {
    const rejectedOnce = join(f.root, "rejected-once");
    const hook = join(f.bare, "hooks", "pre-receive");
    await writeFile(hook, `#!/bin/sh\nif [ ! -f '${rejectedOnce}' ]; then touch '${rejectedOnce}'; exit 1; fi\nexit 0\n`);
    await chmod(hook, 0o755);
    await restoreHomeState(f.env, opts(f.bare));
    await writeFile(join(f.home, "keep.txt"), "after-retry\n");
    await publishHomeState(f.env, opts(f.bare));
    await access(rejectedOnce);
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "after-retry\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("nested HOME ignore cannot override the canonical store selection", async () => {
  const f = await fixture("!.t3/\n!.t3/**\n.t3/**/.env\n");
  try {
    await restoreHomeState(f.env, opts(f.bare));
    await mkdir(join(f.home, ".t3"));
    await writeFile(join(f.home, ".t3", ".gitignore"), "!.env\n");
    await writeFile(join(f.home, ".t3", ".env"), "should-never-be-tracked\n");
    await writeFile(join(f.home, "keep.txt"), "changed\n");
    await assert.rejects(() => publishHomeState(f.env, opts(f.bare)), /T3_RUNNER_STORE_IGNORED_PATH/);
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "from-store\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("no publish is attempted until restore completed, and production secrets are validated", async () => {
  const f = await fixture();
  try {
    await publishHomeState(f.env, opts(f.bare));
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "from-store\n");
    await assert.rejects(() => restoreHomeState({ ...f.env, HOME: "relative" }, opts(f.bare)),
      /INVALID_HOME_STATE/);
    await assert.rejects(() => restoreHomeState({ ...f.env, T3_RUNNER_STORE_REPOSITORY: "invalid" }),
      /T3_RUNNER_STORE_REPOSITORY_REQUIRED/);
    await assert.rejects(() => restoreHomeState({ ...f.env, T3_RUNNER_STORE_REPOSITORY: "owner/name",
      T3_RUNNER_STORE_TOKEN: "" }), /T3_RUNNER_STORE_TOKEN_REQUIRED/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("WAL-only transactions are snapshotted even if the main SQLite file is unchanged", async () => {
  const f = await fixture("!state.sqlite\n");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const db = join(f.work, "state.sqlite");
    await execute("python3", ["-c", `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('pragma journal_mode=WAL');c.execute('create table items(value text)');c.execute("insert into items values ('original')");c.commit();c.close()`, db]);
    await git(f.work, ["add", "state.sqlite"]);
    await git(f.work, ["commit", "-m", "add database"]);
    await git(f.work, ["push", "origin", "HEAD:main"]);
    await restoreHomeState(f.env, opts(f.bare));
    const original = await readFile(join(f.home, "state.sqlite"));
    child = spawn("python3", ["-u", "-c", `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('pragma journal_mode=WAL');c.execute('insert into items values ("in-wal")');c.commit();print('READY',flush=True);sys.stdin.readline();c.close()`, join(f.home, "state.sqlite")],
      { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", d => String(d).includes("READY") ? resolve() : reject(new Error(String(d))));
      child!.once("error", reject);
      child!.once("exit", c => reject(new Error(`sqlite worker exited ${c}`)));
    });
    assert.ok(original.equals(await readFile(join(f.home, "state.sqlite"))), "only WAL has the new row");
    await publishHomeState(f.env, opts(f.bare));
    const { stdout: content } = await execute("git", ["--git-dir", f.bare, "show", "main:state.sqlite"],
      { cwd: f.work, encoding: "buffer" });
    const snapshot = join(f.root, "snapshot.sqlite");
    await writeFile(snapshot, content);
    const { stdout } = await execute("python3", ["-c", `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); print(','.join(x[0] for x in c.execute('select value from items order by rowid')))`, snapshot]);
    assert.equal(stdout.trim(), "original,in-wal");
  } finally {
    child?.stdin?.end("\n");
    await rm(f.root, { recursive: true, force: true });
  }
});

test("periodic checkpoints publish selected state while keeping final teardown available", async () => {
  const f = await fixture();
  let stop: (() => void) | undefined;
  try {
    assert.equal(HOME_CHECKPOINT_INTERVAL_MS, 15 * 60 * 1000);
    await restoreHomeState(f.env, opts(f.bare));
    let resolveFirst!: () => void;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const loop = runCheckpointLoop(f.env, async () => {
      await publishHomeState(f.env, { ...opts(f.bare), retainRestoreMarker: true });
      resolveFirst();
    }, 60);
    stop = () => { void writeFile(checkpointPath(f.env, "stop"), "stop\n"); };
    await writeFile(join(f.home, "keep.txt"), "intermediate\n");
    await Promise.race([
      first,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("periodic checkpoint did not finish")), 8_000)),
    ]);
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "intermediate\n");
    await access(join(f.env.RUNNER_TEMP!, "t3-runner-home-restored"));
    await writeFile(checkpointPath(f.env, "stop"), "stop\n");
    await loop;
    stop = undefined;
    await writeFile(join(f.home, "keep.txt"), "final\n");
    await publishHomeState(f.env, opts(f.bare));
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "final\n");
    await assert.rejects(access(join(f.env.RUNNER_TEMP!, "t3-runner-home-restored")));
  } finally {
    stop?.();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failed checkpoint is retried on the next interval without exposing its error", async () => {
  const f = await fixture();
  try {
    await restoreHomeState(f.env, opts(f.bare));
    await writeFile(join(f.home, "keep.txt"), "recovered\n");
    let attempts = 0;
    await runCheckpointLoop(f.env, async () => {
      attempts++;
      if (attempts === 1) throw new Error("PRIVATE_STORE_TOKEN_DO_NOT_LOG");
      await publishHomeState(f.env, { ...opts(f.bare), retainRestoreMarker: true });
      await writeFile(checkpointPath(f.env, "stop"), "stop\n");
    }, 30);
    assert.equal(attempts, 2);
    assert.equal(await git(f.work, ["--git-dir", f.bare, "show", "main:keep.txt"]), "recovered\n");
    const status = await readFile(checkpointPath(f.env, "status"), "utf8");
    assert.match(status, /^success /);
    assert.doesNotMatch(status, /PRIVATE_STORE_TOKEN/);
    await access(join(f.env.RUNNER_TEMP!, "t3-runner-home-restored"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("the workflow gates restoration on the real owner and keeps backup credentials out of Serve", async () => {
  const source = await readFile(new URL("../.github/workflows/run-environment.yml", import.meta.url), "utf8");
  const browser = source.indexOf("- name: Prepare T3 browser");
  const restore = source.indexOf("- name: Restore runner home state");
  const serve = source.indexOf("- name: Serve Environment");
  const restoreStep = source.slice(restore, serve);
  const publish = source.indexOf("- name: Publish runner home state");
  assert.ok(browser !== -1 && browser < restore && restore < serve && serve < publish);
  assert.match(restoreStep, /home-state-cli\.ts checkpoint-start/);
  assert.match(source.slice(publish), /home-state-cli\.ts checkpoint-stop/);
  assert.match(source.slice(publish), /flock --exclusive --wait 120/);
  assert.match(source, /vars\.T3_RESTORE_RUNNER_HOME == 'true'/);
  assert.match(source, /github\.actor_id == '490285'/);
  assert.match(source, /if: always\(\)/);
  assert.match(source, /T3_RUNNER_STORE_REPOSITORY: \$\{\{ secrets\.T3_RUNNER_STORE_REPOSITORY \}\}/);
  assert.doesNotMatch(source.slice(serve, publish), /T3_RUNNER_STORE_TOKEN|T3_RUNNER_STORE_REPOSITORY/);
});
