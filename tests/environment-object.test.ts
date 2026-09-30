import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";
import { environmentTask } from "../apps/chatgpt-app/src/environment-task.ts";
import type { OperationRecord } from "../apps/chatgpt-app/src/environment-object.ts";
import { sign } from "../apps/chatgpt-app/node_modules/@octokit/webhooks-methods/dist-node/index.js";

test("Environment DO identity and cross-object admission use committed creation", async t => {
  const jobStartedAt = new Date(Date.now() - 300000).toISOString();
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-object.ts", import.meta.url));
  const webhookSource = fileURLToPath(new URL("../apps/chatgpt-app/src/environment-webhook.ts", import.meta.url));
  const built = await build({
    stdin: { contents: `import { EnvironmentObject, EnvironmentAdmissionObject } from ${JSON.stringify(source)};
      import { environmentWebhook } from ${JSON.stringify(webhookSource)};
      const lookupStarted = Promise.withResolvers<void>();
      const lookupReleased = Promise.withResolvers<void>();
      const reserveStarted = Promise.withResolvers<void>();
      const reserveReleased = Promise.withResolvers<void>();
      export class TestEnvironment extends EnvironmentObject {
        async lateSocketError(binding) { await this.webSocketError({ close() {}, deserializeAttachment() { return binding; } } as WebSocket); }
        async waitForLookup() { await lookupStarted.promise; }
        async releaseLookup() { lookupReleased.resolve(); }
        async expireRuntime() { await this.ctx.storage.put('environment-runtime-deadline', 1); }
        async idleDeadline(value: number) { await this.ctx.storage.put('environment-idle-deadline', value); }
        async scheduledAlarm() { return this.ctx.storage.getAlarm(); }
        async latestEvent() { return this.ctx.storage.get('environment-event-latest'); }
        async expireResults() { await this.ctx.storage.put('environment-results-expires-at', 1); }
        async retainedContentCount() { return (await this.ctx.storage.list({ prefix: 'environment-operation:' })).size + (await this.ctx.storage.list({ prefix: 'environment-output:' })).size + (await this.ctx.storage.list({ prefix: 'environment-ci-wait:' })).size; }
        async invokeAlarm() { await this.alarm(); }
      }
      export class FaultAdmission extends EnvironmentAdmissionObject {
        async waitForReserve() { await reserveStarted.promise; }
        async resumeReserve() { reserveReleased.resolve(); }
        async reserve(record) {
          if (record.ownerId === '9') {
            reserveStarted.resolve();
            await reserveReleased.promise;
          }
          return super.reserve(record);
        }
        async failOnce(mode: string) { await this.ctx.storage.put('test-release-fault', mode); }
        async releaseConfirmed(record) {
          const mode = await this.ctx.storage.get('test-release-fault');
          await this.ctx.storage.delete('test-release-fault');
          if (mode === 'before') throw new Error('Controlled failure before release');
          await super.releaseConfirmed(record);
          if (mode === 'after') throw new Error('Controlled lost release reply');
        }
      }
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/workflows/run-environment.yml/dispatches') && init?.method === 'POST') {
          if (JSON.parse(init.body).inputs.environment_id === 'env_${"7".repeat(32)}') return Response.json({ workflow_run_id: 700 });
          return new Response(null, { status: 403 });
        }
        if (String(url).endsWith('/runs/700/attempts/1')) return Response.json({ id: 700, run_attempt: 1,
          repository: { full_name: 'fixture/runner' }, actor: { id: 6 }, path: '.github/workflows/run-environment.yml',
          status: 'completed', conclusion: 'cancelled' });
        if (String(url).endsWith('/runs/123/cancel') && init?.method === 'POST') {
          return new Response(null, { status: 202 });
        }
        if (String(url).endsWith('/runs/123') || String(url).endsWith('/runs/123/attempts/1')) {
          return Response.json({ id: 123, run_attempt: 1, repository: { full_name: 'fixture/runner' },
            actor: { id: 1 }, path: '.github/workflows/run-environment.yml', status: 'in_progress', conclusion: null });
        }
        if (String(url).endsWith('/runs/125/attempts/1/jobs?per_page=100')) {
          lookupStarted.resolve();
          await lookupReleased.promise;
          return Response.json({ total_count: 1, jobs: [{ run_id: 125, name: 'Environment', started_at: '2026-01-01T00:00:00Z' }] });
        }
        if (String(url).endsWith('/runs/123/attempts/1/jobs?per_page=100')) {
          return Response.json({ total_count: 1, jobs: [{ run_id: 123, name: 'Environment', started_at: ${JSON.stringify(jobStartedAt)} }] });
        }
        throw new Error('Unexpected external request in fixture');
      };
      export default { async fetch(request: Request, env) {
        const { target, input, operation } = request.method === 'GET'
          ? JSON.parse(new URL(request.url).searchParams.get('input')!) : await request.json();
        try {
          if (operation === 'webhook') return environmentWebhook(new Request('https://internal/github/events', {
            method: 'POST', body: input.body, headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': input.signature },
          }), { ...env, GITHUB_WEBHOOK_SECRET: 'fixture-webhook-secret' });
          if (operation === 'wait-reserve' || operation === 'resume-reserve') {
            const admission = env.ENVIRONMENT_ADMISSION.getByName('global');
            if (operation === 'wait-reserve') await admission.waitForReserve();
            else await admission.resumeReserve();
            return new Response(null, { status: 204 });
          }
          if (operation === 'list-environments') {
            return Response.json(await env.ENVIRONMENT_ADMISSION.getByName(target).list(input.ownerId));
          }
          if (operation === 'fault') {
            await env.ENVIRONMENT_ADMISSION.getByName('global').failOnce(input.mode);
            return new Response(null, { status: 204 });
          }
          const object = env.ENVIRONMENTS.getByName(target);
          if (operation === 'register-ci') return Response.json(await object.registerGithubWait(input.ownerId, input.taskId, input.waitId, input.target));
          if (operation === 'read-ci') return Response.json(await object.readGithubWait(input.ownerId, input.taskId, input.waitId));
          if (operation === 'complete-ci') return Response.json(await object.completeGithubWaits(input));
          if (operation === 'read-lifecycle-task') return Response.json(await object.readLifecycleTask(input.ownerId, input.kind));
          if (operation === 'observe-lifecycle-task') return new Response(await object.observeLifecycleTask(input.ownerId, input.kind), { headers: { 'content-type': 'text/event-stream' } });
          if (operation === 'cancel-lifecycle-task') { await object.cancelLifecycleTask(input.ownerId, input.kind); return new Response(null, { status: 204 }); }
          if (operation === 'read-environment') return Response.json(await object.readEnvironment(input.ownerId));
          if (operation === 'late-socket-error') { await object.lateSocketError(input); return new Response(null, { status: 204 }); }
          if (operation === 'observe-environment') return new Response(await object.observeEnvironment(input.ownerId), { headers: { 'content-type': 'text/event-stream' } });
          if (operation === 'expire-runtime') { await object.expireRuntime(); return new Response(null, { status: 204 }); }
          if (operation === 'set-idle') { await object.idleDeadline(input.deadline); return new Response(null, { status: 204 }); }
          if (operation === 'alarm-time') return Response.json(await object.scheduledAlarm());
          if (operation === 'latest-event') return Response.json(await object.latestEvent());
          if (operation === 'expire-results') { await object.expireResults(); return new Response(null, { status: 204 }); }
          if (operation === 'content-count') return Response.json(await object.retainedContentCount());
          if (operation === 'alarm') { await object.invokeAlarm(); return new Response(null, { status: 204 }); }
          if (operation === 'wait-lookup') { await object.waitForLookup(); return new Response(null, { status: 204 }); }
          if (operation === 'release-lookup') { await object.releaseLookup(); return new Response(null, { status: 204 }); }
          if (operation === 'close') return Response.json(await object.requestClose(input.ownerId));
          if (operation === 'close-backend') return Response.json(await object.closeExecution(input.ownerId, 'fixture-token'));
          if (operation === 'dispatch-execution') return Response.json(await object.dispatchExecution(input.ownerId, 'fixture-token'));
          if (operation === 'bind') return Response.json(await object.bindExecution(input));
          if (operation === 'claim-runtime') return Response.json(await object.claimRuntime(input, 'fixture-token'));
          if (operation === 'runtime') return Response.json(await object.bindRuntime(input));
          if (operation === 'reserve-operation') return Response.json(await object.reserveOperation(input.ownerId, input.taskId, input.request));
          if (operation === 'read-operation') return Response.json(await object.readOperation(input.ownerId, input.taskId));
          if (operation === 'read-output') return Response.json(await object.readOutput(input.ownerId, input.taskId));
          if (operation === 'observe-output') return new Response(await object.observeOutput(input.ownerId, input.taskId), { headers: { 'content-type': 'text/event-stream' } });
          if (operation === 'cancel-operation') { await object.cancelOperation(input.ownerId, input.taskId); return new Response(null, { status: 204 }); }
          if (operation === 'answer-operation') { await object.answerOperation(input.ownerId, input.taskId, input.responses); return new Response(null, { status: 204 }); }
          if (operation === 'observe-operation') return new Response(await object.observeOperation(input.ownerId, input.taskId), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
          if (operation === 'upgrade') return object.fetch(new Request('https://internal/connect', {
            headers: { upgrade: 'websocket', 'x-harness-runtime-claim': JSON.stringify(input) },
          }));
          if (operation === 'deadline') return Response.json(await object.establishRuntimeDeadline(input.ownerId, 'fixture-token', input.policy));
          if (operation === 'stopped') return Response.json(await object.confirmExecutionStopped(input));
          if (operation === 'observe') return Response.json(await object.observeStop(input.ownerId, 'unused-fixture-token'));
          return Response.json(operation === 'dispatch'
            ? await object.beginDispatch(input.ownerId) : await object.initialize(input));
        }
        catch { return new Response(null, { status: 409 }); }
      } };`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", cf: false,
    bindings: { ENVIRONMENT_STARTUP_MS: 60000, GITHUB_RUNNER_REPOSITORY: "fixture/runner",
      GITHUB_CI_EVENT_REPOSITORIES: JSON.stringify(["fixture/target"]) },
    durableObjects: {
      ENVIRONMENTS: { className: "TestEnvironment", useSQLite: true },
      ENVIRONMENT_ADMISSION: { className: "FaultAdmission", useSQLite: true },
    },
  });
  t.after(() => mf.dispose());
  const environmentId = `env_${"a".repeat(32)}`;
  const input = { environmentId, ownerId: "1", executor: "codex" };
  const call = (target: string, value: unknown = input, operation = "initialize") => {
    const body = JSON.stringify({ target, input: value, operation });
    return operation === "upgrade"
      ? mf.dispatchFetch(`http://test/?input=${encodeURIComponent(body)}`, { headers: { upgrade: "websocket" } })
      : mf.dispatchFetch("http://test/", { method: "POST", body });
  };
  assert.equal((await call(`env_${"b".repeat(32)}`)).status, 409);
  const cancelledId = `env_${"f".repeat(32)}`;
  const cancelledInput = { environmentId: cancelledId, ownerId: "42", executor: "codex" };
  assert.equal((await call(cancelledId, cancelledInput)).status, 200);
  const lifecycleTask = async (target: string, ownerId: string, kind: string) =>
    (await call(target, { ownerId, kind }, "read-lifecycle-task")).json();
  assert.equal((await lifecycleTask(cancelledId, "42", "open")).status, "working");
  assert.equal(await lifecycleTask(cancelledId, "43", "open"), null);
  assert.equal(await lifecycleTask(cancelledId, "42", "close"), null);
  await call(cancelledId, { ownerId: "42", kind: "open" }, "cancel-lifecycle-task");
  const cancelledOpen = await lifecycleTask(cancelledId, "42", "open");
  assert.equal(cancelledOpen.status, "cancelled");
  const completedClose = await lifecycleTask(cancelledId, "42", "close");
  assert.equal(completedClose.status, "completed");
  await call(cancelledId, { ownerId: "42", kind: "close" }, "cancel-lifecycle-task");
  await call(cancelledId, cancelledInput, "close");
  assert.deepEqual(await lifecycleTask(cancelledId, "42", "close"), completedClose);
  assert.deepEqual(await lifecycleTask(cancelledId, "42", "open"), cancelledOpen);
  const responses = await Promise.all([call(environmentId), call(environmentId)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const first = await responses[0].json();
  const openReader = (await call(environmentId, { ownerId: "1", kind: "open" }, "observe-lifecycle-task")).body!.getReader();
  assert.match(new TextDecoder().decode((await openReader.read()).value), /"status":"working"/);
  const openedNotification = openReader.read();
  assert.deepEqual(await responses[1].json(), first);
  assert.deepEqual(await (await call(environmentId)).json(), first);
  const readEnvironment = () => call(environmentId, { ownerId: "1" }, "read-environment").then(response => response.json()) as Promise<{
    status: string; reason?: string; expiresAt: number | null; activeTaskId: string | null;
    reconnectDiagnostic?: { category: string; observedAt: number }; idleExpiresAt?: number | null;
  }>;
  assert.equal((await readEnvironment()).status, "opening");
  assert.equal((await readEnvironment()).expiresAt, null);
  assert.equal(await (await call(environmentId, { ownerId: "2" }, "read-environment")).json(), null);
  assert.deepEqual(await (await call("global", { ownerId: "1" }, "list-environments")).json(), [environmentId]);
  assert.deepEqual(await (await call("global", { ownerId: "2" }, "list-environments")).json(), []);
  const refusedId = `env_${"c".repeat(32)}`;
  assert.deepEqual(await (await call(refusedId, { ...input, environmentId: refusedId })).json(), {
    admitted: false, capacityKind: "owner", retryable: false, existingEnvironmentId: environmentId,
  });
  assert.equal(await lifecycleTask(refusedId, "1", "open"), null);
  assert.equal((await call(refusedId, input, "dispatch")).status, 409);
  assert.deepEqual(await (await call("global", { ownerId: "1" }, "list-environments")).json(), [environmentId]);
  assert.equal((await call("other", { ownerId: "1" }, "list-environments")).status, 409);
  assert.equal((await call("global", { ownerId: "01" }, "list-environments")).status, 409);
  assert.equal((await call(environmentId, { ...input, executor: "grok" })).status, 409);
  assert.equal((await call(environmentId, { ...input, ownerId: "2" })).status, 409);
  const second = `env_${"c".repeat(32)}`;
  assert.deepEqual(await (await call(second, { ...input, environmentId: second })).json(), {
    admitted: false, capacityKind: "owner", retryable: false, existingEnvironmentId: environmentId,
  });
  assert.equal((await call(second, input, "dispatch")).status, 409);
  assert.equal((await call(environmentId, { ...input, ownerId: "2" }, "dispatch")).status, 409);
  const dispatch = await Promise.all([call(environmentId, input, "dispatch"), call(environmentId, input, "dispatch")]);
  assert.deepEqual((await Promise.all(dispatch.map(response => response.json()))).sort(), ["already-issued", "send"]);
  assert.equal(await (await call(environmentId, input, "dispatch")).json(), "already-issued");
  const execution = { ownerId: "1", repository: "fixture/runner", runId: "123", runAttempt: "1" };
  const deadlineInput = { ownerId: "1", policy: { jobName: "Environment", jobBudgetMs: 3600000, cleanupMs: 60000 } };
  assert.equal((await call(environmentId, deadlineInput, "deadline")).status, 409);
  assert.equal(await (await call(environmentId, execution, "bind")).json(), "bound");
  assert.equal(await (await call(environmentId, execution, "bind")).json(), "bound");
  const deadlines = await Promise.all([call(environmentId, deadlineInput, "deadline"), call(environmentId, deadlineInput, "deadline")]);
  const expectedDeadline = Date.parse(jobStartedAt) + 3540000;
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(await (await call(environmentId, execution, "claim-runtime")).json(),
      { decision: "bound", executor: "codex", deadline: expectedDeadline });
  }
  assert.deepEqual(await Promise.all(deadlines.map(response => response.json())), [expectedDeadline, expectedDeadline]);
  assert.equal(await (await call(environmentId, { ...deadlineInput,
    policy: { ...deadlineInput.policy, jobBudgetMs: 7200000 } }, "deadline")).json(), expectedDeadline);
  assert.equal((await call(environmentId, { ...deadlineInput, ownerId: "2" }, "deadline")).status, 409);
  const runtimeClaim = { ...execution, runtimeId: "00000000-0000-4000-8000-000000000001" };
  const connections = await Promise.all([call(environmentId, runtimeClaim, "runtime"), call(environmentId, runtimeClaim, "runtime")]);
  const bindings = await Promise.all(connections.map(response => response.json())) as Array<{ generation: number; deadline: number }>;
  assert.deepEqual(bindings.map(binding => binding.generation).sort(), [1, 2]);
  assert.ok(bindings.every(binding => binding.deadline === expectedDeadline));
  const sockets = [];
  const nextMessage = (socket: NonNullable<Awaited<ReturnType<typeof mf.dispatchFetch>>["webSocket"]>, includeCiResult = false) => new Promise<unknown>(resolve => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ci-result" && !includeCiResult) return;
      socket.removeEventListener("message", listener);
      resolve(message);
    };
    socket.addEventListener("message", listener);
  });
  for (let index = 0; index < 2; index++) {
    const response = await call(environmentId, runtimeClaim, "upgrade");
    assert.equal(response.status, 101);
    const socket = response.webSocket!;
    const connected = nextMessage(socket);
    socket.accept();
    assert.deepEqual(await connected, { type: "connected", generation: index + 3, deadline: expectedDeadline });
    sockets.push(socket);
  }
  const staleClosed = new Promise<number>(resolve => sockets[0]!.addEventListener("close", event => resolve(event.code), { once: true }));
  sockets[0]!.send(JSON.stringify({ type: "ready" }));
  assert.equal(await staleClosed, 1008);
  assert.equal((await readEnvironment()).status, "opening");
  const readyReply = nextMessage(sockets[1]!);
  assert.equal((await call(environmentId, { ownerId: "2" }, "observe-environment")).status, 409);
  const lifecycle = await call(environmentId, input, "observe-environment");
  const lifecycleReader = lifecycle.body!.getReader();
  const lifecycleDecoder = new TextDecoder();
  let lifecycleText = "";
  const nextLifecycle = async (): Promise<{ status: string; activeTaskId: string | null }> => {
    while (!lifecycleText.includes("\n\n")) {
      const chunk = await lifecycleReader.read();
      assert.equal(chunk.done, false);
      lifecycleText += lifecycleDecoder.decode(chunk.value, { stream: true });
    }
    const boundary = lifecycleText.indexOf("\n\n");
    const value = JSON.parse(lifecycleText.slice(6, boundary));
    lifecycleText = lifecycleText.slice(boundary + 2);
    return value;
  };
  const untilLifecycle = async (status: string) => {
    for (;;) { const value = await nextLifecycle(); if (value.status === status) return value; }
  };
  t.after(() => lifecycleReader.cancel());
  assert.equal((await nextLifecycle()).status, "opening");
  sockets[1]!.send(JSON.stringify({ type: "ready" }));
  assert.deepEqual(await readyReply, { type: "ready-accepted" });
  assert.equal((await readEnvironment()).status, "ready");
  const readyEvent = await (await call(environmentId, input, "latest-event")).json();
  assert.deepEqual(readyEvent.data, { environmentId, revision: 1, kind: "environment", status: "ready" });
  const opened = await lifecycleTask(environmentId, "1", "open");
  assert.equal(opened.status, "completed");
  assert.equal(opened.result.structuredContent.outcome, "opened");
  // Other Environment events can emit an unchanged pending snapshot first.
  let openNotice = await openedNotification;
  while (!new TextDecoder().decode(openNotice.value).includes('"status":"completed"')) openNotice = await openReader.read();
  await openReader.cancel();
  await call(environmentId, { ownerId: "1", kind: "open" }, "cancel-lifecycle-task");
  assert.equal((await readEnvironment()).status, "ready");
  assert.equal((await nextLifecycle()).status, "ready");
  assert.equal((await readEnvironment()).expiresAt, expectedDeadline);
  const firstIdle = await (await call(environmentId, input, "alarm-time")).json() as number;
  assert.ok(firstIdle > Date.now() && firstIdle < expectedDeadline);
  const duplicateReady = nextMessage(sockets[1]!);
  sockets[1]!.send(JSON.stringify({ type: "ready" }));
  assert.deepEqual(await duplicateReady, { type: "ready-accepted" });
  assert.deepEqual(await (await call(environmentId, input, "latest-event")).json(), readyEvent);
  assert.equal(await (await call(environmentId, input, "alarm-time")).json(), firstIdle);
  const agentState = { defaults: { model: "fixture-model", reasoningEffort: "high" },
    models: [{ id: "fixture-model", effort: "high", efforts: ["low", "high"] }], selection: null, uncertain: false };
  const modelReply = nextMessage(sockets[1]!);
  sockets[1]!.send(JSON.stringify({ type: "agent-state", generation: 4, state: agentState }));
  assert.deepEqual(await modelReply, { type: "agent-state-accepted", generation: 4 });
  const modelView = await (await call(environmentId, input, "read-environment")).json() as {
    agent: { state: unknown; current: boolean }; idleExpiresAt: number;
  };
  assert.deepEqual(modelView.agent.state, agentState);
  assert.equal(modelView.agent.current, true);
  assert.equal(modelView.idleExpiresAt, firstIdle);
  assert.equal(await (await call(environmentId, input, "alarm-time")).json(), firstIdle);
  const operation = { ownerId: "1", taskId: "operation-one", request: JSON.stringify({ kind: "agent", prompt: "hello" }) };
  assert.equal((await call(environmentId, { ...operation, ownerId: "2" }, "reserve-operation")).status, 409);
  for (let repeat = 0; repeat < 2; repeat++) {
    const delivered = nextMessage(sockets[1]!);
    assert.equal((await call(environmentId, operation, "reserve-operation")).status, 200);
    assert.deepEqual(await delivered, { type: "execute", generation: 4,
      taskId: operation.taskId, input: JSON.parse(operation.request) });
  }
  assert.equal((await call(environmentId, { ...operation, request: JSON.stringify({ kind: "agent", prompt: "other" }) }, "reserve-operation")).status, 409);
  const storedRequest = await (await call(environmentId, operation, "read-operation")).json() as { request: string };
  assert.equal(storedRequest.request, operation.request);
  assert.equal((await readEnvironment()).activeTaskId, operation.taskId);
  const ciTarget = { repository: "fixture/target", runId: "501", runAttempt: 2, revision: "a".repeat(40) };
  const ciResult = { ...ciTarget, conclusion: "success" };
  const wireWait = { type: "ci-register", generation: 4, taskId: operation.taskId,
    waitId: "00000000-0000-4000-8000-000000000097", target: { ...ciTarget, runId: "503" } };
  let wireReply = nextMessage(sockets[1]!);
  sockets[1]!.send(JSON.stringify(wireWait));
  assert.deepEqual(await wireReply, { type: "ci-accepted", generation: 4, taskId: operation.taskId, waitId: wireWait.waitId });
  const wireResult = { ...wireWait.target, conclusion: "failure" };
  wireReply = nextMessage(sockets[1]!, true);
  sockets[1]!.send(JSON.stringify({ type: "ci-observed", generation: 4, taskId: operation.taskId, waitId: wireWait.waitId, result: wireResult }));
  assert.deepEqual(await wireReply, { type: "ci-result", generation: 4, taskId: operation.taskId, waitId: wireWait.waitId, result: wireResult });
  wireReply = nextMessage(sockets[1]!);
  sockets[1]!.send(JSON.stringify({ ...wireWait, target: { ...wireWait.target, repository: "uncovered/repo" } }));
  assert.deepEqual(await wireReply, { type: "ci-rejected", generation: 4, taskId: operation.taskId,
    waitId: wireWait.waitId, code: "CI_EVENT_COVERAGE_REQUIRED" });
  assert.equal(await (await call(environmentId, ciResult, "complete-ci")).json(), 0);
  const ci = { ownerId: "1", taskId: operation.taskId, waitId: "00000000-0000-4000-8000-000000000099", target: ciTarget };
  assert.equal((await call(environmentId, { ...ci, ownerId: "2" }, "register-ci")).status, 409);
  assert.equal((await call(environmentId, { ...ci, target: { ...ciTarget, repository: "uncovered/repo" } }, "register-ci")).status, 409);
  assert.equal((await call(environmentId, { ...ci, taskId: "not-active" }, "register-ci")).status, 409);
  assert.deepEqual(await (await call(environmentId, ci, "register-ci")).json(), { taskId: operation.taskId, target: ciTarget });
  assert.deepEqual(await (await call(environmentId, ci, "register-ci")).json(), { taskId: operation.taskId, target: ciTarget });
  assert.equal((await call(environmentId, { ...ci, target: { ...ciTarget, runAttempt: 3 } }, "register-ci")).status, 409);
  for (const wrong of [{ ...ciResult, runAttempt: 3 }, { ...ciResult, revision: "b".repeat(40) },
    { ...ciResult, repository: "other/repo" }, { ...ciResult, runId: "502" }]) {
    assert.equal(await (await call(environmentId, wrong, "complete-ci")).json(), 0);
  }
  const ciEventBody = JSON.stringify({ action: "completed", repository: { full_name: ciTarget.repository },
    workflow_run: { id: Number(ciTarget.runId), run_attempt: ciTarget.runAttempt, head_sha: ciTarget.revision,
      display_title: "CI", actor: { id: 1 }, repository: { full_name: ciTarget.repository },
      path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" } });
  const ciDelivered = new Promise<unknown>(resolve => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== "ci-result" || message.waitId !== ci.waitId) return;
      sockets[1]!.removeEventListener("message", listener);
      resolve(message);
    };
    sockets[1]!.addEventListener("message", listener);
  });
  assert.equal((await call(environmentId, { body: ciEventBody,
    signature: await sign("fixture-webhook-secret", ciEventBody) }, "webhook")).status, 204);
  assert.deepEqual(await ciDelivered, { type: "ci-result", generation: 4, taskId: operation.taskId, waitId: ci.waitId, result: ciResult });
  assert.equal(await (await call(environmentId, ciResult, "complete-ci")).json(), 0);
  assert.equal(await (await call(environmentId, { ...ciResult, conclusion: "failure" }, "complete-ci")).json(), 0);
  assert.deepEqual(await (await call(environmentId, ci, "read-ci")).json(), { taskId: operation.taskId, target: ciTarget, result: ciResult });
  assert.equal(await (await call(environmentId, input, "alarm-time")).json(), expectedDeadline);
  for (const request of ["null", "[]", "broken", JSON.stringify({ prompt: "x".repeat(65536) })]) {
    assert.equal((await call(environmentId, { ...operation, taskId: "invalid-input", request }, "reserve-operation")).status, 409);
  }
  assert.equal((await call(environmentId, { ...operation, taskId: "operation-two" }, "reserve-operation")).status, 409);
  const inputId = "00000000-0000-4000-8000-000000000010";
  const question = { type: "input", generation: 4, taskId: operation.taskId, inputId,
    request: { method: "elicitation/create", params: { mode: "form", message: "Name?",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } };
  const publishQuestion = async () => {
    const ack = nextMessage(sockets[1]!);
    sockets[1]!.send(JSON.stringify(question));
    assert.deepEqual(await ack, { type: "input-accepted", taskId: operation.taskId, inputId, generation: 4 });
    const inputEvent = await (await call(environmentId, input, "latest-event")).json();
    assert.equal(inputEvent.data.kind, "operation");
    assert.equal(inputEvent.data.status, "input_required");
    assert.equal(inputEvent.data.operationId, operation.taskId);
    assert.doesNotMatch(JSON.stringify(inputEvent), /requestedSchema|hello|PRIVATE/);
  };
  await publishQuestion();
  const readRecord = async () => await (await call(environmentId, operation, "read-operation")).json() as OperationRecord;
  assert.equal(environmentTask(operation.taskId, await readRecord()).status, "input_required");
  assert.equal((await call(environmentId, { ...operation, responses: { [inputId]: { action: "accept", content: { name: 1 } } } }, "answer-operation")).status, 409);
  const answer = { action: "accept", content: { name: "Ada" } };
  {
    const messages: unknown[] = [];
    const delivered = new Promise<void>(resolve => {
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "ci-result") return;
        messages.push(message);
        if (messages.length === 2) { sockets[1]!.removeEventListener("message", listener); resolve(); }
      };
      sockets[1]!.addEventListener("message", listener);
    });
    assert.equal((await call(environmentId, { ...operation, responses: { [inputId]: answer } }, "answer-operation")).status, 204);
    await delivered;
    assert.deepEqual(messages[1], { type: "input-response", generation: 4, taskId: operation.taskId, inputId, response: answer });
  }
  await publishQuestion();
  assert.equal(environmentTask(operation.taskId, await readRecord()).status, "working");
  const answeredRecord = await readRecord();
  for (const responses of [{ [inputId]: answer }, { [inputId]: { action: "cancel" } }, { unknown: null }, { constructor: null }]) {
    assert.equal((await call(environmentId, { ...operation, responses }, "answer-operation")).status, 204);
    assert.deepEqual(await readRecord(), answeredRecord);
  }
  const outcome = { ok: true, value: { status: "completed", finalResponse: "x".repeat(140000) } };
  assert.equal((await call(environmentId, { ...operation, ownerId: "2" }, "observe-operation")).status, 409);
  const observation = await call(environmentId, operation, "observe-operation");
  const reader = observation.body!.getReader();
  const initialSnapshot = await reader.read();
  assert.equal(JSON.parse(new TextDecoder().decode(initialSnapshot.value).slice(6)).status, "working");
  const streamed = { revision: 1, text: "LIVE_OUTPUT", truncated: false };
  assert.equal((await call(environmentId, { ...operation, ownerId: "2" }, "observe-output")).status, 409);
  const outputStream = await call(environmentId, operation, "observe-output");
  const outputReader = outputStream.body!.getReader();
  const nextOutput = async () => {
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await outputReader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    return JSON.parse(text.slice(6));
  };
  assert.deepEqual(await nextOutput(), { revision: 0, text: "", truncated: false });
  const outputFrame = { type: "output", generation: 4, taskId: operation.taskId, output: streamed };
  const outputAck = nextMessage(sockets[1]!);
  sockets[1]!.send(JSON.stringify(outputFrame));
  assert.deepEqual(await outputAck, { type: "output-accepted", generation: 4, taskId: operation.taskId, revision: 1 });
  assert.deepEqual(await nextOutput(), streamed);
  await outputReader.cancel();
  assert.deepEqual(await (await call(environmentId, operation, "read-output")).json(), streamed);
  assert.equal(await (await call(environmentId, { ...operation, ownerId: "2" }, "read-output")).json(), null);
  const beforeResult = await (await call(environmentId, operation, "read-operation")).json() as { result?: unknown };
  assert.equal(beforeResult.result, undefined);
  const finalOutput = { revision: 3, text: "LIVE_OUTPUT\nFINAL_OUTPUT", truncated: false };
  const frame = { type: "result", generation: 4, taskId: operation.taskId, result: outcome, output: finalOutput };
  let resultIdle: unknown;
  for (let repetition = 0; repetition < 2; repetition++) {
    const acknowledged = nextMessage(sockets[1]!);
    sockets[1]!.send(JSON.stringify(frame));
    assert.deepEqual(await acknowledged, { type: "result-accepted", generation: 4, taskId: operation.taskId });
    const finishedEvent = await (await call(environmentId, input, "latest-event")).json();
    assert.equal(finishedEvent.data.status, "completed");
    assert.equal(finishedEvent.data.operationId, operation.taskId);
    const alarm = await (await call(environmentId, input, "alarm-time")).json();
    if (repetition === 0) resultIdle = alarm;
    else assert.equal(alarm, resultIdle);
  }
  const stored = await (await call(environmentId, operation, "read-operation")).json() as { result: typeof outcome };
  assert.equal(stored.result.value.finalResponse.length, 140000);
  assert.equal((await call(environmentId, { ...operation, responses: { [inputId]: answer } }, "answer-operation")).status, 204);
  assert.deepEqual(await readRecord(), stored);
  assert.equal((await call(environmentId, { ...operation, ownerId: "2", responses: { [inputId]: answer } }, "answer-operation")).status, 409);
  const oldOutputAck = nextMessage(sockets[1]!);
  sockets[1]!.send(JSON.stringify(outputFrame));
  assert.deepEqual(await oldOutputAck, { type: "output-accepted", generation: 4, taskId: operation.taskId, revision: 1 });
  assert.deepEqual(await (await call(environmentId, operation, "read-output")).json(), finalOutput);
  let received = "";
  while (!received.includes("\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += new TextDecoder().decode(chunk.value);
  }
  const completedSnapshot = JSON.parse(received.split("\n")[0]!.slice(6));
  assert.equal(completedSnapshot.status, "completed");
  assert.equal(completedSnapshot.result.structuredContent.finalResponse.length, 140000);
  assert.equal(completedSnapshot.runtimeId, undefined);
  await reader.cancel();
  const resumedObservation = await call(environmentId, operation, "observe-operation");
  const resumedReader = resumedObservation.body!.getReader();
  let resumedText = "";
  while (!resumedText.includes("\n")) {
    const chunk = await resumedReader.read();
    assert.equal(chunk.done, false);
    resumedText += new TextDecoder().decode(chunk.value);
  }
  assert.equal(JSON.parse(resumedText.split("\n")[0]!.slice(6)).status, "completed");
  await resumedReader.cancel();
  assert.equal(await (await call(environmentId, { ...operation, ownerId: "2" }, "read-operation")).json(), null);
  const secondDelivery = nextMessage(sockets[1]!);
  assert.equal((await call(environmentId, { ...operation, taskId: "operation-two" }, "reserve-operation")).status, 200);
  assert.deepEqual(await secondDelivery, { type: "execute", generation: 4,
    taskId: "operation-two", input: JSON.parse(operation.request) });
  const retainedWait = { ...ci, taskId: "operation-two", waitId: "00000000-0000-4000-8000-000000000096" };
  assert.equal((await call(environmentId, retainedWait, "register-ci")).status, 200);
  const conflictClosed = new Promise<number>(resolve => sockets[1]!.addEventListener("close", event => resolve(event.code), { once: true }));
  sockets[1]!.send(JSON.stringify({ ...frame, result: { ok: false, code: "OPERATION_FAILED" } }));
  assert.equal(await conflictClosed, 1008);
  assert.equal((await readEnvironment()).status, "unavailable");
  assert.deepEqual(await lifecycleTask(environmentId, "1", "open"), opened);
  assert.equal((await readEnvironment()).reason, "runtime_disconnected");
  const disconnected = await readEnvironment();
  assert.equal(disconnected.reconnectDiagnostic?.category, "control_plane_rejected");
  assert.ok(Number.isSafeInteger(disconnected.reconnectDiagnostic?.observedAt));
  assert.deepEqual(Object.keys(disconnected.reconnectDiagnostic!).sort(), ["category", "observedAt"]);
  const reconnectIdle = disconnected.idleExpiresAt;
  assert.equal((await untilLifecycle("unavailable")).status, "unavailable");
  // Commit while disconnected, then require delivery from the stored receipt on the next generation.
  assert.equal(await (await call(environmentId, ciResult, "complete-ci")).json(), 1);
  assert.deepEqual(await (await call(environmentId, retainedWait, "read-ci")).json(),
    { taskId: "operation-two", target: ciTarget, result: ciResult });
  const replayConnection = await call(environmentId, runtimeClaim, "upgrade");
  assert.equal(replayConnection.status, 101);
  const replaySocket = replayConnection.webSocket!;
  const replayHello = nextMessage(replaySocket);
  replaySocket.accept();
  assert.deepEqual(await replayHello, { type: "connected", generation: 5, deadline: expectedDeadline });
  assert.deepEqual((await readEnvironment()).reconnectDiagnostic, disconnected.reconnectDiagnostic);
  const replayMessages: unknown[] = [];
  const replayed = new Promise<void>(resolve => {
    const listener = (event: MessageEvent) => {
      replayMessages.push(JSON.parse(String(event.data)));
      if (replayMessages.length === 3) {
        replaySocket.removeEventListener("message", listener);
        resolve();
      }
    };
    replaySocket.addEventListener("message", listener);
  });
  replaySocket.send(JSON.stringify({ type: "ready" }));
  await replayed;
  assert.deepEqual(replayMessages, [{ type: "ready-accepted" },
    { type: "execute", generation: 5, taskId: "operation-two", input: JSON.parse(operation.request) },
    { type: "ci-result", generation: 5, taskId: "operation-two", waitId: retainedWait.waitId, result: ciResult }]);
  assert.equal((await readEnvironment()).reconnectDiagnostic, undefined);
  assert.equal((await readEnvironment()).idleExpiresAt, reconnectIdle);
  assert.equal((await readEnvironment()).expiresAt, expectedDeadline);
  await call(environmentId, { ...runtimeClaim, generation: 4 }, "late-socket-error");
  assert.equal((await readEnvironment()).status, "ready");
  assert.equal((await readEnvironment()).reconnectDiagnostic, undefined);
  const replayClosed = new Promise<void>(resolve => replaySocket.addEventListener("close", () => resolve(), { once: true }));
  replaySocket.close(1000, "Controlled disconnect before cancellation");
  await replayClosed;
  assert.equal((await readEnvironment()).reconnectDiagnostic?.category, "transport_closed");
  const disconnectedAgent = await (await call(environmentId, input, "read-environment")).json() as {
    agent: { current: boolean; state: unknown };
  };
  assert.equal(disconnectedAgent.agent.current, false);
  assert.deepEqual(disconnectedAgent.agent.state, agentState);
  const cancelledOperation = { ...operation, taskId: "operation-two" };
  assert.equal((await call(environmentId, { ...cancelledOperation, ownerId: "2" }, "cancel-operation")).status, 409);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await call(environmentId, cancelledOperation, "cancel-operation")).status, 204);
  }
  const cancellationRecord = await (await call(environmentId, cancelledOperation, "read-operation")).json() as { cancelRequested?: boolean; result?: unknown };
  assert.equal(cancellationRecord.cancelRequested, true);
  assert.equal(cancellationRecord.result, undefined);
  assert.equal((await call(environmentId, { ...operation, taskId: "while-cancelling" }, "reserve-operation")).status, 409);
  const reconnected = await call(environmentId, runtimeClaim, "upgrade");
  assert.equal(reconnected.status, 101);
  const resumedSocket = reconnected.webSocket!;
  const resumedHello = nextMessage(resumedSocket);
  resumedSocket.accept();
  assert.deepEqual(await resumedHello, { type: "connected", generation: 6, deadline: expectedDeadline });
  assert.equal((await readEnvironment()).status, "unavailable");
  const resumedMessages: unknown[] = [];
  const redelivered = new Promise<void>(resolve => resumedSocket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    resumedMessages.push(message);
    if (resumedMessages.length === 3) resolve();
  }));
  resumedSocket.send(JSON.stringify({ type: "ready" }));
  await redelivered;
  assert.deepEqual(resumedMessages, [{ type: "ready-accepted" }, { type: "execute", generation: 6,
    taskId: "operation-two", input: JSON.parse(operation.request) },
    { type: "cancel", generation: 6, taskId: "operation-two" }]);
  const cancelAcknowledged = nextMessage(resumedSocket);
  resumedSocket.send(JSON.stringify({ type: "result", generation: 6, taskId: "operation-two",
    output: { revision: 0, text: "", truncated: false },
    result: { ok: true, value: { status: "cancelled" } } }));
  assert.deepEqual(await cancelAcknowledged, { type: "result-accepted", generation: 6, taskId: "operation-two" });
  const confirmedCancellation = await (await call(environmentId, cancelledOperation, "read-operation")).json() as { result: unknown };
  assert.deepEqual(confirmedCancellation.result, { ok: true, value: { status: "cancelled" } });
  const preserved = await (await call(environmentId, operation, "read-operation")).json() as { result: typeof outcome };
  assert.equal(preserved.result.value.finalResponse.length, 140000);
  assert.deepEqual(await (await call(environmentId, operation, "read-output")).json(), finalOutput);
  for (const change of [{ runtimeId: "00000000-0000-4000-8000-000000000002" }, { runId: "124" }, { ownerId: "2" }]) {
    assert.equal((await call(environmentId, { ...runtimeClaim, ...change }, "runtime")).status, 409);
  }
  for (const changed of [{ runId: "124" }, { runAttempt: "2" }, { repository: "other/runner" }, { ownerId: "2" }]) {
    assert.equal((await call(environmentId, { ...execution, ...changed }, "bind")).status, 409);
  }
  assert.equal(await (await call(environmentId, { ...input, ownerId: "2" }, "close")).json(), null);
  assert.equal((await readEnvironment()).status, "ready");
  const idleAfterResult = await (await call(environmentId, input, "alarm-time")).json() as number;
  assert.ok(idleAfterResult < expectedDeadline);
  await call(environmentId, { deadline: 1 }, "set-idle");
  assert.equal((await readEnvironment()).reason, "idle_expired");
  assert.equal((await call(environmentId, { ...operation, taskId: "after-idle" }, "reserve-operation")).status, 409);
  await call(environmentId, { deadline: idleAfterResult }, "set-idle");
  const unfinished = { ...operation, taskId: "unfinished-at-stop" };
  const executeUnfinished = nextMessage(resumedSocket);
  assert.equal((await call(environmentId, unfinished, "reserve-operation")).status, 200);
  assert.equal((await executeUnfinished as { taskId: string }).taskId, unfinished.taskId);
  const cancelledWait = { ...ci, taskId: unfinished.taskId, waitId: "00000000-0000-4000-8000-000000000098" };
  assert.equal((await call(environmentId, cancelledWait, "register-ci")).status, 200);
  const unfinishedInput = nextMessage(resumedSocket);
  resumedSocket.send(JSON.stringify({ ...question, generation: 6, taskId: unfinished.taskId }));
  assert.equal((await unfinishedInput as { type: string }).type, "input-accepted");
  const unfinishedStream = await call(environmentId, unfinished, "observe-operation");
  const unfinishedReader = unfinishedStream.body!.getReader();
  t.after(() => unfinishedReader.cancel());
  const pendingSnapshot = await unfinishedReader.read();
  assert.match(new TextDecoder().decode(pendingSnapshot.value), /"status":"input_required"/);
  const cancelledSnapshot = unfinishedReader.read();
  assert.equal((await call(environmentId, unfinished, "cancel-operation")).status, 204);
  assert.match(new TextDecoder().decode((await cancelledSnapshot).value), /"status":"working"/);
  const afterCancel = await (await call(environmentId, unfinished, "read-operation")).json() as OperationRecord;
  assert.equal(afterCancel.cancelRequested, true);
  assert.equal(await (await call(environmentId, ciResult, "complete-ci")).json(), 0);
  assert.equal((await call(environmentId, cancelledWait, "read-ci")).status, 409);
  assert.equal((await call(environmentId, unfinished, "cancel-operation")).status, 204);
  assert.deepEqual(await (await call(environmentId, unfinished, "read-operation")).json(), afterCancel);
  const terminalSnapshot = unfinishedReader.read();
  await call(environmentId, input, "expire-runtime");
  assert.equal((await readEnvironment()).status, "unavailable");
  assert.equal((await readEnvironment()).reason, "runtime_expired");
  const closeInstruction = nextMessage(resumedSocket);
  assert.equal((await call(environmentId, input, "alarm")).status, 204);
  assert.deepEqual(await closeInstruction, { type: "close", generation: 6 });
  assert.equal((await readEnvironment()).status, "closing");
  assert.equal((await untilLifecycle("closing")).status, "closing");
  assert.equal((await call(environmentId, deadlineInput, "deadline")).status, 409);
  assert.equal((await call(environmentId, runtimeClaim, "runtime")).status, 409);
  const repeatedClose = nextMessage(resumedSocket);
  assert.equal(await (await call(environmentId, input, "close")).json(), "closing");
  assert.deepEqual(await repeatedClose, { type: "close", generation: 6 });
  resumedSocket.close(1000);
  assert.equal((await call(environmentId, { ...input, ownerId: "2" }, "close-backend")).status, 409);
  assert.equal(await (await call(environmentId, input, "close-backend")).json(), "closing");
  assert.equal((await call(environmentId, input, "dispatch")).status, 409);
  assert.equal(await (await call(environmentId, execution, "bind")).json(), "stop");
  assert.deepEqual(await (await call(environmentId, execution, "claim-runtime")).json(), { decision: "stop" });
  assert.deepEqual(await (await call(second, { ...input, environmentId: second })).json(), {
    admitted: false, capacityKind: "owner", retryable: false, existingEnvironmentId: environmentId,
  });

  const third = `env_${"d".repeat(32)}`;
  const beforeDispatch = { ...input, environmentId: third, ownerId: "2" };
  assert.equal((await call(third, beforeDispatch)).status, 200);
  assert.equal(await (await call(third, beforeDispatch, "close")).json(), "closed");
  assert.deepEqual(await (await call("global", { ownerId: "2" }, "list-environments")).json(), []);
  assert.equal((await call(third, beforeDispatch, "dispatch")).status, 409);
  assert.equal((await call(third, beforeDispatch)).status, 409);
  assert.equal((await call(third, { ...execution, ownerId: "2" }, "bind")).status, 409);
  const racingId = `env_${"9".repeat(32)}`;
  const racingCreation = { ...input, environmentId: racingId, ownerId: "9" };
  const pendingAdmission = call(racingId, racingCreation);
  assert.equal((await call("global", {}, "wait-reserve")).status, 204);
  assert.equal(await (await call(racingId, racingCreation, "close")).json(), "closing");
  assert.equal((await call("global", {}, "resume-reserve")).status, 204);
  assert.equal((await pendingAdmission).status, 409);
  assert.equal(await (await call(racingId, racingCreation, "close")).json(), "closed");
  assert.deepEqual(await (await call("global", { ownerId: "9" }, "list-environments")).json(), []);
  assert.equal((await call(racingId, racingCreation, "dispatch")).status, 409);
  const lateId = `env_${"e".repeat(32)}`;
  const late = { ...input, environmentId: lateId, ownerId: "3" };
  assert.equal((await call(lateId, late)).status, 200);
  assert.equal(await (await call(lateId, late, "dispatch")).json(), "send");
  assert.equal(await (await call(lateId, { ...execution, ownerId: "3", runId: "125" }, "bind")).json(), "bound");
  const pendingDeadline = call(lateId, { ...deadlineInput, ownerId: "3" }, "deadline");
  assert.equal((await call(lateId, late, "wait-lookup")).status, 204);
  await call(lateId, { ownerId: "3", kind: "open" }, "cancel-lifecycle-task");
  assert.equal((await lifecycleTask(lateId, "3", "open")).status, "working");
  assert.equal((await lifecycleTask(lateId, "3", "close")).status, "working");
  await call(lateId, { ownerId: "3", kind: "close" }, "cancel-lifecycle-task");
  assert.equal((await lifecycleTask(lateId, "3", "close")).status, "working");
  assert.equal((await call(lateId, late, "release-lookup")).status, 204);
  assert.equal((await pendingDeadline).status, 409);
  assert.equal(await (await call(lateId, { ...execution, ownerId: "3", runId: "125" }, "bind")).json(), "stop");
  assert.equal((await call(environmentId, { ...execution, runAttempt: "2" }, "stopped")).status, 409);
  const completedEvent = async (attempt: number) => {
    const body = JSON.stringify({ action: "completed", repository: { full_name: execution.repository },
      workflow_run: { id: Number(execution.runId), run_attempt: attempt, display_title: environmentId,
        actor: { id: Number(execution.ownerId) }, repository: { full_name: execution.repository },
        path: ".github/workflows/run-environment.yml", status: "completed", conclusion: "cancelled" } });
    return call(environmentId, { body, signature: await sign("fixture-webhook-secret", body) }, "webhook");
  };
  assert.equal((await completedEvent(2)).status, 503);
  const readUnfinished = async () => await (await call(environmentId, unfinished, "read-operation")).json() as { result?: unknown; updatedAt: number };
  assert.equal((await readUnfinished()).result, undefined);
  assert.deepEqual(await (await call(second, { ...input, environmentId: second })).json(), {
    admitted: false, capacityKind: "owner", retryable: false, existingEnvironmentId: environmentId,
  });
  assert.equal((await completedEvent(1)).status, 204);
  const ended = await readUnfinished();
  assert.deepEqual(ended.result, { ok: false, code: "ENVIRONMENT_ENDED_OUTCOME_UNKNOWN" });
  assert.match(new TextDecoder().decode((await terminalSnapshot).value), /"status":"failed"/);
  await unfinishedReader.cancel();
  assert.equal((await readEnvironment()).activeTaskId, null);
  assert.deepEqual((await (await call(environmentId, operation, "read-operation")).json() as { result: unknown }).result, preserved.result);
  assert.equal((await readEnvironment()).status, "closed");
  assert.equal((await lifecycleTask(environmentId, "1", "open")).status, "completed");
  assert.equal((await lifecycleTask(environmentId, "1", "open")).lastUpdatedAt, opened.lastUpdatedAt);
  assert.equal((await lifecycleTask(environmentId, "1", "close")).status, "completed");
  const retentionAlarm = await (await call(environmentId, input, "alarm-time")).json() as number;
  assert.ok(retentionAlarm > Date.now() + 6 * 24 * 60 * 60 * 1000);
  assert.equal((await untilLifecycle("closed")).status, "closed");
  await lifecycleReader.cancel();
  assert.deepEqual(await (await call("global", { ownerId: "1" }, "list-environments")).json(), []);
  assert.equal(await (await call(environmentId, input, "close-backend")).json(), "closed");
  assert.equal(await (await call(environmentId, execution, "stopped")).json(), "closed");
  const closedEvent = await (await call(environmentId, input, "latest-event")).json();
  assert.equal(closedEvent.data.kind, "environment");
  assert.equal(closedEvent.data.status, "closed");
  assert.deepEqual(await readUnfinished(), ended);
  assert.equal(await (await call(environmentId, input, "close")).json(), "closed");
  assert.equal(await (await call(environmentId, input, "observe")).json(), "closed");
  assert.equal(await (await call(environmentId, execution, "bind")).json(), "stop");
  assert.equal((await call(environmentId)).status, 409);
  assert.equal(await (await call(environmentId, input, "alarm-time")).json(), retentionAlarm);
  const retained = await (await call(environmentId, operation, "read-operation")).json() as OperationRecord;
  assert.equal(environmentTask(operation.taskId, retained).ttlMs, retentionAlarm - retained.createdAt);
  await call(environmentId, input, "expire-results");
  assert.equal(await lifecycleTask(environmentId, "1", "open"), null);
  assert.equal(await lifecycleTask(environmentId, "1", "close"), null);
  assert.equal(await (await call(environmentId, operation, "read-operation")).json(), null);
  assert.equal(await (await call(environmentId, operation, "read-output")).json(), null);
  assert.equal((await call(environmentId, operation, "reserve-operation")).status, 409);
  assert.equal(await (await call(environmentId, input, "read-environment")).json(), null);
  assert.ok(await (await call(environmentId, input, "content-count")).json() as number > 0);
  assert.equal((await call(environmentId, input, "alarm")).status, 204);
  assert.equal(await (await call(environmentId, input, "content-count")).json(), 0);
  assert.equal(await (await call(environmentId, input, "alarm-time")).json(), null);
  assert.equal((await call(environmentId, input)).status, 409);
  assert.equal((await call(environmentId, execution, "bind")).status, 200);
  assert.equal((await call(environmentId, input, "dispatch")).status, 409);
  assert.equal((await call(second, { ...input, environmentId: second })).status, 200);
  for (const [index, mode] of ["before", "after"].entries()) {
    const faultId = `env_${String(index + 4).repeat(32)}`;
    const faultInput = { ...input, environmentId: faultId, ownerId: String(index + 4) };
    const faultExecution = { ...execution, ownerId: faultInput.ownerId, runId: String(index + 200) };
    assert.equal((await call(faultId, faultInput)).status, 200);
    assert.equal(await (await call(faultId, faultInput, "dispatch")).json(), "send");
    if (index === 0) await call(faultId, faultInput, "close");
    assert.equal(await (await call(faultId, faultExecution, "bind")).json(), index === 0 ? "stop" : "bound");
    assert.equal((await call(faultId, { mode }, "fault")).status, 204);
    assert.equal((await call(faultId, faultExecution, "stopped")).status, 409);
    assert.equal(await (await call(faultId, faultInput, "close")).json(), "closing");
    // Stop evidence survives both faults; the fixture rejects any external fetch.
    assert.equal(await (await call(faultId, faultInput, "observe")).json(), "closed");
    assert.equal(await (await call(faultId, faultInput, "close")).json(), "closed");
  }
  const rejectedId = `env_${"6".repeat(32)}`;
  const rejectedInput = { ...input, environmentId: rejectedId, ownerId: "6" };
  assert.equal((await call(rejectedId, rejectedInput)).status, 200);
  assert.equal(await (await call(rejectedId, rejectedInput, "dispatch-execution")).json(), "rejected");
  assert.equal(await (await call(rejectedId, rejectedInput, "close")).json(), "closed");
  assert.equal((await call(rejectedId, rejectedInput, "dispatch-execution")).status, 409);
  const replacementId = `env_${"7".repeat(32)}`;
  assert.equal((await call(replacementId, { ...rejectedInput, environmentId: replacementId })).status, 200);
  assert.equal(await (await call(replacementId, rejectedInput, "dispatch-execution")).json(), "accepted");
  assert.equal(await (await call(replacementId, rejectedInput, "dispatch-execution")).json(), "already-issued");
  assert.equal((await call(replacementId, { ...execution, ownerId: "6", runId: "701" }, "bind")).status, 409);
  assert.equal(await (await call(replacementId, rejectedInput, "observe")).json(), "closed");

  // A real idle socket disconnect/error/reconnect must keep the exact idle alarm.
  const idleId = `env_${"8".repeat(32)}`;
  const idleInput = { ...input, environmentId: idleId, ownerId: "10" };
  const idleExecution = { ...execution, ownerId: "10" };
  const idleClaim = { ...runtimeClaim, ownerId: "10" };
  await call(idleId, idleInput);
  await call(idleId, idleInput, "dispatch");
  await call(idleId, idleExecution, "bind");
  await call(idleId, { ...deadlineInput, ownerId: "10" }, "deadline");
  const idleSocket = (await call(idleId, idleClaim, "upgrade")).webSocket!;
  const idleHello = nextMessage(idleSocket);
  idleSocket.accept(); await idleHello;
  const idleReady = nextMessage(idleSocket);
  idleSocket.send(JSON.stringify({ type: "ready" })); await idleReady;
  const idleAlarm = await (await call(idleId, idleInput, "alarm-time")).json();
  const idleSnapshot = () => call(idleId, idleInput, "read-environment").then(response => response.json()) as ReturnType<typeof readEnvironment>;
  const idleClosed = new Promise<void>(resolve => idleSocket.addEventListener("close", () => resolve(), { once: true }));
  idleSocket.close(1000, "PRIVATE_TOKEN https://private.example/provider"); await idleClosed;
  assert.equal((await idleSnapshot()).reconnectDiagnostic?.category, "transport_closed");
  assert.equal(await (await call(idleId, idleInput, "alarm-time")).json(), idleAlarm);
  await call(idleId, { ...idleClaim, generation: 1 }, "late-socket-error");
  assert.equal((await idleSnapshot()).reconnectDiagnostic?.category, "transport_failure");
  assert.doesNotMatch(JSON.stringify(await idleSnapshot()), /PRIVATE|private.example|runtimeId|generation/);
  // A rejected replacement identity supplies no fact about this runtime's reconnect cause.
  assert.equal((await call(idleId, { ...idleClaim, runtimeId: "00000000-0000-4000-8000-000000000002" }, "upgrade")).status, 409);
  const idleReconnect = (await call(idleId, idleClaim, "upgrade")).webSocket!;
  const idleReconnectHello = nextMessage(idleReconnect);
  idleReconnect.accept(); await idleReconnectHello;
  const idleReconnectReady = nextMessage(idleReconnect);
  idleReconnect.send(JSON.stringify({ type: "ready" })); await idleReconnectReady;
  assert.equal((await idleSnapshot()).reconnectDiagnostic, undefined);
  assert.equal((await idleSnapshot()).idleExpiresAt, idleAlarm);
  assert.equal((await idleSnapshot()).expiresAt, expectedDeadline);
  assert.equal(await (await call(idleId, idleInput, "alarm-time")).json(), idleAlarm);
  await call(idleId, { ...idleClaim, generation: 1 }, "late-socket-error");
  assert.equal((await idleSnapshot()).reconnectDiagnostic, undefined);
  await call(idleId, { deadline: 1 }, "set-idle");
  assert.equal((await idleSnapshot()).reason, "idle_expired");
  await call(idleId, idleInput, "alarm");
  assert.equal((await idleSnapshot()).status, "closing");
  assert.deepEqual(await (await call("global", { ownerId: "10" }, "list-environments")).json(), [idleId]);
  assert.equal(await (await call(idleId, idleExecution, "stopped")).json(), "closed");
  assert.equal((await idleSnapshot()).reconnectDiagnostic, undefined);
});
