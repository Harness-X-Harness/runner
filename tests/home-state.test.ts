import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { T3_RUNNER_STORE_OWNER_ID, T3_RUNNER_STORE_REPOSITORY, publishHomeState, restoreHomeState } from "../.github/actions/agent-runtime/home-state.ts";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } });
  return stdout;
}

test("restore overlays ignored-file selection and publish pushes it back", async () => {
  const root = await mkdtemp(join(tmpdir(), "home-state-"));
  const work = join(root, "work");
  const bare = join(root, "store.git");
  const home = join(root, "home");
  await mkdir(work);
  await mkdir(home);
  await git(work, ["init", "-b", "main"]);
  await mkdir(join(work, ".githooks"));
  await writeFile(join(work, ".gitignore"), "*\n!.gitignore\n!.githooks/\n!.githooks/**\n!keep.txt\n");
  await writeFile(join(work, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  await chmod(join(work, ".githooks", "pre-commit"), 0o755);
  await writeFile(join(work, "keep.txt"), "from-store\n");
  await writeFile(join(work, "secret.txt"), "not-tracked\n");
  await git(work, ["add", ".gitignore", ".githooks/pre-commit", "keep.txt"]);
  await git(work, ["commit", "-m", "initial"]);
  await execute("git", ["init", "--bare", "-b", "main", bare]);
  await git(work, ["remote", "add", "origin", bare]);
  await git(work, ["push", "origin", "HEAD:main"]);
  await writeFile(join(home, "keep.txt"), "old\n");
  await writeFile(join(home, "installed-binary"), "stay\n");
  const env = { HOME: home, T3_RESTORE_HOME: "1", T3_RUNNER_STORE_URL: bare };
  try {
    await restoreHomeState(env);
    assert.equal(await readFile(join(home, "keep.txt"), "utf8"), "from-store\n");
    assert.equal(await readFile(join(home, "installed-binary"), "utf8"), "stay\n");
    assert.equal(await readFile(join(home, "secret.txt"), "utf8").catch(() => ""), "");
    assert.equal((await git(home, ["config", "--get", "core.hooksPath"])).trim(), ".githooks");
    assert.equal((await git(home, ["remote", "get-url", "origin"])).trim(), bare);
    await writeFile(join(home, "keep.txt"), "after-run\n");
    await publishHomeState(env);
    assert.equal(await git(work, ["--git-dir", bare, "show", "HEAD:keep.txt"]), "after-run\n");
    const tracked = await git(work, ["--git-dir", bare, "ls-tree", "-r", "--name-only", "HEAD"]);
    assert.match(tracked, /^keep\.txt$/m);
    assert.doesNotMatch(tracked, /installed-binary|secret\.txt/);
    const tip = (await git(work, ["--git-dir", bare, "rev-parse", "HEAD"])).trim();
    await publishHomeState(env);
    assert.equal((await git(work, ["--git-dir", bare, "rev-parse", "HEAD"])).trim(), tip);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("home restore is inert unless the flag is set", async () => {
  await restoreHomeState({ HOME: "/tmp", T3_RUNNER_STORE_TOKEN: "unused" });
  await publishHomeState({ HOME: "/tmp" });
  await assert.rejects(() => restoreHomeState({ HOME: "/tmp", T3_RESTORE_HOME: "1",
    T3_RUNNER_STORE_URL: `https://github.com/${T3_RUNNER_STORE_REPOSITORY}.git` }),
  /T3_RUNNER_STORE_TOKEN_REQUIRED/);
});

test("workflow keeps the store token behind the owner gate and out of setup steps", async () => {
  const source = await readFile(new URL("../.github/workflows/run-environment.yml", import.meta.url), "utf8");
  const serveAt = source.indexOf("- name: Serve Environment");
  const homeAt = source.indexOf("- name: Prepare runner home state");
  const browserAt = source.indexOf("- name: Prepare T3 browser");
  assert.ok(browserAt > source.indexOf("- name: Install T3 service"));
  assert.ok(homeAt > browserAt);
  assert.ok(serveAt > homeAt);
  assert.doesNotMatch(source.slice(0, serveAt), /secrets\./);
  assert.match(source, new RegExp(`\\[ "\\$ACTOR_ID" = "${T3_RUNNER_STORE_OWNER_ID}" \\]`));
  assert.match(source, /restore_runner_home:/);
  assert.match(source, /vars\.T3_RESTORE_RUNNER_HOME/);
  assert.match(source, /secrets\.T3_RUNNER_STORE_TOKEN/);
  assert.match(source, /T3_RUNNER_STORE_TOKEN: \$\{\{ steps\.home\.outputs\.enabled == '1' && secrets\.T3_RUNNER_STORE_TOKEN \|\| '' \}\}/);
});
