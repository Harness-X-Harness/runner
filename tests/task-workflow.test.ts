import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { parse } from "../apps/chatgpt-app/node_modules/yaml/dist/index.js";
import { z } from "../.github/actions/agent-runtime/node_modules/zod/index.js";
import { claimTask, executeTask, finishTask, taskDirectory } from "../.github/actions/task-runtime/index.ts";
import { AgentRuntime, type Executor } from "../.github/actions/agent-runtime/index.ts";
import { TASK_LIMITS, newTaskId } from "../shared/task-contract.ts";
import { TaskError } from "../shared/task-errors.ts";

const requestUrl = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : input);
const stepSchema = z.object({
  name: z.string().optional(), uses: z.string().optional(), run: z.string().optional(),
  if: z.string().optional(), with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const workflowSchema = z.object({
  on: z.object({ workflow_dispatch: z.object({ inputs: z.record(z.string(), z.unknown()) }) }).passthrough(),
  permissions: z.record(z.string(), z.string()),
  jobs: z.object({ task: z.object({
    "timeout-minutes": z.number(), env: z.record(z.string(), z.string()), steps: z.array(stepSchema),
  }) }),
});

async function fixture(t: TestContext, executor: Executor = "codex") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-task-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "home");
  await mkdir(home);
  const env = {
    TASK_ID: newTaskId(), TASK_CONTROL_PLANE_URL: "https://runner.example",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?request=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "PRIVATE_OIDC_REQUEST",
    GITHUB_OUTPUT: path.join(temporary, "outputs"), GITHUB_TOKEN: "PRIVATE_JOB_TOKEN",
    RUNNER_TEMP: temporary, HOME: home, PATH: process.env.PATH,
  };
  let oidc = 0;
  const calls: { url: URL; headers: Headers; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    calls.push({ url, headers: request.headers, body: await request.text() });
    if (url.hostname === "oidc.example") return Response.json({ value: `PRIVATE_ASSERTION_${++oidc}` });
    if (url.pathname.endsWith("/claim")) return Response.json({ taskId: env.TASK_ID, executor, prompt: "PRIVATE_PROMPT" });
    return Response.json({ status: "completed" });
  };
  const agentEnv = { ...env, MINI_END_USER_KEY: "PRIVATE_PROVIDER_KEY", GH_TOKEN: "PRIVATE_AGENT_TOKEN",
    MINI_CODEX_BASE_URL: "https://private-codex.example/v1", MINI_GROK_BASE_URL: "https://private-grok.example/v1" };
  return { env, agentEnv, calls, fetchImpl };
}

test("Task workflow exposes only task_id and secrets only to the post-claim Agent step", async () => {
  const source = await readFile(new URL("../.github/workflows/run-task.yml", import.meta.url), "utf8");
  const workflow = workflowSchema.parse(parse(source));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["task_id"]);
  assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
  const job = workflow.jobs.task;
  assert.equal(job["timeout-minutes"], 60);
  assert.deepEqual(Object.keys(job.env).sort(), ["TASK_CONTROL_PLANE_URL", "TASK_ID"]);
  const checkout = job.steps[0];
  const claim = job.steps.find(step => step.with?.phase === "claim");
  const codex = job.steps.find(step => step.name === "Install Codex");
  const grok = job.steps.find(step => step.name === "Install Grok");
  const agent = job.steps.find(step => step.with?.phase === "execute");
  const finish = job.steps.find(step => step.with?.phase === "finish");
  assert.ok(checkout.with && claim?.with && codex && grok && agent?.with && agent.env && finish?.with);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(claim.with.phase, "claim");
  assert.equal(codex.if, "steps.claim.outputs.executor == 'codex'");
  assert.equal(grok.if, "steps.claim.outputs.executor == 'grok'");
  assert.equal(codex.run, "curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  assert.equal(grok.run, "curl -fsSL https://x.ai/cli/install.sh | bash");
  assert.deepEqual(Object.keys(agent.env).sort(), ["GH_TOKEN", "MINI_CODEX_BASE_URL", "MINI_END_USER_KEY", "MINI_GROK_BASE_URL"]);
  assert.equal(agent.env.GH_TOKEN, "${{ secrets.AGENT_GITHUB_TOKEN }}");
  assert.equal(agent.with.phase, "execute");
  assert.equal(finish.if, "${{ always() && steps.claim.outcome == 'success' }}");
  assert.equal(finish.with.phase, "finish");
  for (const step of job.steps.filter(step => step !== agent)) assert.doesNotMatch(JSON.stringify(step), /secrets\./);
  assert.doesNotMatch(source, /GITHUB_ENV|upload-artifact|run-name|continue-on-error|git (clone|commit|push)|gh pr/);
});

test("claim handoff is private and outputs only the validated executor", async (t) => {
  const { env, fetchImpl, calls } = await fixture(t);
  await claimTask({ env, fetchImpl });
  const directory = taskDirectory(env);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const file = path.join(directory, "claim.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const claim = JSON.parse(await readFile(file, "utf8"));
  assert.equal(claim.prompt, "PRIVATE_PROMPT");
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "executor=codex\n");
  assert.equal(calls[0].url.searchParams.get("audience"), "https://runner.example");
  assert.equal(calls[1].headers.get("authorization"), "Bearer PRIVATE_ASSERTION_1");
  assert.equal(calls[1].body, "{}");
  assert.equal(calls[1].url.search, "");
});

test("rejected claim creates no private handoff or execution output", async (t) => {
  const { env } = await fixture(t);
  await assert.rejects(claimTask({ env, fetchImpl: async (url) => requestUrl(url).hostname === "oidc.example"
    ? Response.json({ value: "PRIVATE_ASSERTION" }) : new Response("PRIVATE_BACKEND_ERROR", { status: 409 }) }), { code: "CLAIM_REJECTED" });
  await assert.rejects(stat(taskDirectory(env)), { code: "ENOENT" });
  await assert.rejects(stat(env.GITHUB_OUTPUT), { code: "ENOENT" });
});

test("both native runtime paths receive workspace and prompt but no inherited job OIDC authority", async (t) => {
  for (const executor of ["codex", "grok"] as const) {
    const { env, agentEnv, fetchImpl, calls } = await fixture(t, executor);
    await claimTask({ env, fetchImpl });
    let runtime: AgentRuntime | undefined;
    let childEnv: NodeJS.ProcessEnv | undefined;
    const execution = executeTask({ env: agentEnv, runtimeFactory: (selected, options) => {
      assert.equal(selected, executor);
      assert.ok(options.env);
      childEnv = options.env;
      runtime = new AgentRuntime(selected, { ...options, agentProcess: {
        command: process.execPath,
        args: [fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
        workspace: path.join(taskDirectory(env), "workspace"), env: options.env,
      } });
      return runtime;
    } });
    await execution;
    assert.ok(childEnv);
    assert.equal(childEnv.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
    assert.equal(childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, undefined);
    assert.equal(childEnv.GH_TOKEN, "PRIVATE_AGENT_TOKEN");
    assert.equal(childEnv.MINI_END_USER_KEY, "PRIVATE_PROVIDER_KEY");
    const configFile = path.join(env.HOME, executor === "codex" ? ".codex" : ".grok", "config.toml");
    const config = await readFile(configFile, "utf8");
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    assert.match(config, /env_key = "MINI_END_USER_KEY"/);
    assert.doesNotMatch(config, /PRIVATE_PROVIDER_KEY|PRIVATE_AGENT_TOKEN/);
    const resultFile = path.join(taskDirectory(env), "result.json");
    assert.equal((await stat(resultFile)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), { status: "completed", result: { finalResponse: "PRIVATE_FINAL" } });
    await finishTask({ env, fetchImpl });
    assert.equal(calls.at(-1)?.headers.get("authorization"), "Bearer PRIVATE_ASSERTION_2");
    assert.equal(calls.at(-1)?.url.search, "");
    assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), `executor=${executor}\n`);
    assert.ok(runtime?.closed);
  }
});

test("execution stores bounded final text or canonical failure, never raw logs", async (t) => {
  const logs: unknown[][] = [];
  for (const method of ["log", "error", "warn"] as const) t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  for (const failure of [false, true]) {
    const { env, agentEnv, fetchImpl } = await fixture(t);
    await claimTask({ env, fetchImpl });
    const run = executeTask({ env: agentEnv, runtimeFactory: () => ({
      async run({ prompt, workingDirectory }) {
        assert.equal(prompt, "PRIVATE_PROMPT");
        assert.equal((await stat(workingDirectory)).mode & 0o777, 0o700);
        if (failure) throw new Error("PRIVATE_NATIVE_ERROR");
        return { finalResponse: "文".repeat(TASK_LIMITS.resultBytes) };
      },
    }) });
    if (failure) await assert.rejects(run, { code: "INTERNAL_ERROR" });
    else await run;
    const result = JSON.parse(await readFile(path.join(taskDirectory(env), "result.json"), "utf8"));
    if (failure) assert.deepEqual(result, { status: "failed", error: new TaskError("INTERNAL_ERROR").toJSON() });
    else {
      assert.equal(result.result.truncated, true);
      assert.ok(Buffer.byteLength(result.result.finalResponse) <= TASK_LIMITS.resultBytes);
    }
  }
  assert.deepEqual(logs, []);
});

test("finish retries only bounded ambiguous delivery with fresh OIDC and the same payload", async (t) => {
  const { env, fetchImpl, calls } = await fixture(t);
  await claimTask({ env, fetchImpl });
  const delays: number[] = [];
  let finishes = 0;
  const flaky: typeof fetch = async (url, options) => {
    const response = await fetchImpl(url, options);
    if (requestUrl(url).pathname.endsWith("/finish") && ++finishes < 3) return new Response(null, { status: 503 });
    return response;
  };
  await finishTask({ env: { ...env, TASK_AGENT_OUTCOME: "skipped" }, fetchImpl: flaky, delay: async (ms) => { delays.push(ms); } });
  const attempts = calls.filter((x) => x.url.pathname.endsWith("/finish"));
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(new Set(attempts.map((x) => x.headers.get("authorization"))).size, 3);
  assert.equal(new Set(attempts.map((x) => x.body)).size, 1);
  assert.equal(JSON.parse(attempts[0].body).error.code, "PROVIDER_UNAVAILABLE");
  calls.length = 0;
  await assert.rejects(finishTask({ env, fetchImpl: async (url, options) => {
    const response = await fetchImpl(url, options);
    return requestUrl(url).pathname.endsWith("/finish") ? new Response(null, { status: 409 }) : response;
  }, delay: async () => assert.fail("definitive rejection must not retry") }), { code: "CLAIM_REJECTED" });
  assert.equal(calls.filter((x) => x.url.pathname.endsWith("/finish")).length, 1);
  calls.length = 0;
  await assert.rejects(finishTask({ env, fetchImpl: async (url, options) => {
    const response = await fetchImpl(url, options);
    if (requestUrl(url).pathname.endsWith("/finish")) throw new Error("PRIVATE_NETWORK_ERROR");
    return response;
  }, delay: async () => {} }), { code: "INTERNAL_ERROR" });
  assert.equal(calls.filter((x) => x.url.pathname.endsWith("/finish")).length, 3);
});
