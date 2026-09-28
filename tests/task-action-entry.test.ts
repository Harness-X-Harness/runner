import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { newTaskId } from "../shared/task-contract.ts";

const exec = promisify(execFile);

test("TypeScript Action claims before Agent dependencies are installed", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-action-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Copy only the modules required before npm ci. No node_modules is available.
  for (const relative of [
    ".github/actions/task-runtime/index.ts", ".github/actions/task-runtime/package.json",
    ".github/actions/runner-identity.ts",
    ".github/actions/agent-runtime/index.ts", ".github/actions/agent-runtime/package.json",
    "shared/task-contract.ts", "shared/task-errors.ts",
  ]) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(new URL(`../${relative}`, import.meta.url), target);
  }
  const taskId = newTaskId();
  const output = path.join(directory, "outputs");
  const claim = { taskId, executor: "codex", prompt: "PRIVATE_CLAIM_PROMPT" };
  const preloader = `globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "oidc.example") return Response.json({ value: "PRIVATE_IDENTITY" });
    if (url.href === "https://control.example/internal/tasks/${taskId}/claim") return Response.json(${JSON.stringify(claim)});
    throw new Error("Unexpected request");
  };`;
  const result = await exec(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preloader)}`,
    path.join(directory, ".github/actions/task-runtime/index.ts"),
  ], {
    env: {
      INPUT_PHASE: "claim", TASK_ID: taskId, TASK_CONTROL_PLANE_URL: "https://control.example",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "PRIVATE_JOB_TOKEN", RUNNER_TEMP: directory, GITHUB_OUTPUT: output,
    },
    timeout: 10_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(await readFile(output, "utf8"), "executor=codex\n");
  const privateFile = path.join(directory, `harness-${taskId}`, "claim.json");
  assert.deepEqual(JSON.parse(await readFile(privateFile, "utf8")), claim);
  assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
});
