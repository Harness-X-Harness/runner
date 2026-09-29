import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connectEnvironment } from "../.github/actions/agent-runtime/environment-connection.ts";
import { serveEnvironmentConnection, serveEnvironmentConnections } from "../.github/actions/agent-runtime/environment-channel.ts";
import { EnvironmentRuntime } from "../.github/actions/agent-runtime/environment-runtime.ts";
import { EnvironmentOperations } from "../.github/actions/agent-runtime/environment-operations.ts";
import type { EnvironmentPort } from "../.github/actions/agent-runtime/environment.ts";
import { EnvironmentCiWaits } from "../.github/actions/agent-runtime/environment-ci-waits.ts";
import { EnvironmentInput } from "../.github/actions/agent-runtime/environment-input.ts";
import { EnvironmentOutput } from "../.github/actions/agent-runtime/environment-output.ts";
import { withEnvironment } from "../.github/actions/agent-runtime/environment.ts";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { WebSocketServer }: typeof import("../.github/actions/agent-runtime/node_modules/@types/ws/index.d.ts") =
  createRequire(new URL("../.github/actions/agent-runtime/package.json", import.meta.url))("ws");

test("output acknowledgement coalesces pending revisions into the latest snapshot", { timeout: 5000 }, async t => {
  const output = new EnvironmentOutput();
  output.begin("stream");
  const controller = new AbortController();
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected execution"); };
  const environment: EnvironmentPort = { signal: controller.signal, output,
    inputs: new EnvironmentInput(), ciWaits: new EnvironmentCiWaits(),
    execute: unexpected, cancel: unexpected, command: unexpected, agent: unexpected,
    close: async () => { controller.abort(); } };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    controller.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const snapshots: Array<{ revision: number; text: string; truncated: boolean }> = [];
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "connected", generation: 1, deadline: Date.now() + 4000 }));
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "ready") socket.send(JSON.stringify({ type: "ready-accepted" }));
      if (message.type !== "output") return;
      snapshots.push(message.output);
      if (snapshots.length === 1) {
        // Keep revision zero unacknowledged while every append notifies the channel.
        for (let index = 0; index < 100; index++) output.append("stream", "x");
        socket.send(JSON.stringify({ type: "output-accepted", generation: 1,
          taskId: "stream", revision: message.output.revision }));
      } else socket.close(1000);
    });
  });
  const connection = await connectEnvironment(new URL(`ws://127.0.0.1:${address.port}/connect`),
    "00000000-0000-4000-8000-000000000001", async () => "fixture", AbortSignal.timeout(3000));
  await serveEnvironmentConnection(connection, environment, () => 1);
  assert.deepEqual(snapshots, [
    { revision: 0, text: "", truncated: false },
    { revision: 100, text: "x".repeat(100), truncated: false },
  ]);
});

test("channel transports a native ACP question and resumes its exact answer", { timeout: 6000 }, async t => {
  const deadline = Date.now() + 5000;
  const result = Promise.withResolvers<unknown>();
  const outputSnapshots: Array<{ revision: number; text: string; truncated: boolean }> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", socket => {
    let question: { taskId: string; inputId: string } | undefined;
    const answer = () => {
      if (!question || !outputSnapshots.some(output => output.text === "VISIBLE_BEFORE_INPUT")) return;
      socket.send(JSON.stringify({ type: "input-response", generation: 1, ...question,
        response: { action: "accept", content: { marker: "WIRE_RESUMED" } } }));
      question = undefined;
    };
    socket.send(JSON.stringify({ type: "connected", generation: 1, deadline }));
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "ready") {
        socket.send(JSON.stringify({ type: "ready-accepted" }));
        socket.send(JSON.stringify({ type: "execute", generation: 1, taskId: "question",
          input: { kind: "agent", prompt: "stream-question" } }));
      } else if (message.type === "input") {
        question = { taskId: message.taskId, inputId: message.inputId }; answer();
      } else if (message.type === "output") {
        outputSnapshots.push(message.output);
        socket.send(JSON.stringify({ type: "output-accepted", generation: 1, taskId: message.taskId, revision: message.output.revision }));
        answer();
      } else if (message.type === "result") {
        outputSnapshots.push(message.output); result.resolve(message.result); socket.close(1000);
      }
    });
  });
  await withEnvironment({ command: process.execPath,
    args: [fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
    workspace: process.cwd(), env: {} }, "codex", deadline, {}, {
    sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  }, async environment => {
    const connection = await connectEnvironment(new URL(`ws://127.0.0.1:${address.port}/connect`),
      "00000000-0000-4000-8000-000000000001", async () => "fixture", AbortSignal.timeout(3000));
    await serveEnvironmentConnection(connection, environment, () => 1);
  });
  assert.deepEqual(await result.promise, { ok: true, value: { status: "completed",
    finalResponse: JSON.stringify({ action: "accept", content: { marker: "WIRE_RESUMED" } }),
    model: "gpt-6-sol", reasoningEffort: "high" } });
  assert.ok(outputSnapshots.some(output => output.text === "VISIBLE_BEFORE_INPUT"));
  assert.ok(!JSON.stringify(outputSnapshots).includes("PRIVATE_REASONING"));
  assert.ok(outputSnapshots.at(-1)!.text.includes("WIRE_RESUMED"));
});

for (const reconnect of [false, true])
test(`native ACP CI wait resumes once across channel delivery, reconnect=${reconnect}`, { timeout: 8000 }, async t => {
  const deadline = Date.now() + 6500;
  let reads = 0; let registrations = 0;
  let generation = 0;
  const waitIds = new Set<string>();
  let completion: { taskId: string; waitId: string; result: unknown } | undefined;
  const result = Promise.withResolvers<unknown>();
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(url, "https://api.github.com/repos/fixture/repo/actions/runs/12/attempts/1");
    assert.equal(waitIds.size, 1); reads++;
    return Response.json({ id: 12, run_attempt: 1, head_sha: "a".repeat(40),
      repository: { full_name: "fixture/repo" }, status: "in_progress", conclusion: null });
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  server.on("connection", socket => {
    const current = ++generation;
    socket.send(JSON.stringify({ type: "connected", generation: current, deadline }));
    socket.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "ready") {
        socket.send(JSON.stringify({ type: "ready-accepted" }));
        socket.send(JSON.stringify({ type: "execute", generation: current, taskId: "ci-turn", input: { kind: "agent", prompt: "ci-wait" } }));
      } else if (message.type === "ci-register") {
        registrations++;
        waitIds.add(message.waitId);
        const observed = { taskId: message.taskId, waitId: message.waitId,
          result: { ...message.target, conclusion: "success" } };
        if (completion) assert.deepEqual(observed, completion);
        else completion = observed;
        socket.send(JSON.stringify({ type: "ci-accepted", generation: current, taskId: message.taskId, waitId: message.waitId }));
        // Lose the first delivery socket after registration. Only the same pending
        // native call on the next generation may consume the retained result.
        if (reconnect && current === 1) { socket.close(1000); return; }
        socket.send(JSON.stringify({ type: "ci-result", generation: current, ...completion }));
      } else if (message.type === "output") {
        socket.send(JSON.stringify({ type: "output-accepted", generation: current, taskId: message.taskId, revision: message.output.revision }));
      } else if (message.type === "result") {
        result.resolve(message.result);
        socket.send(JSON.stringify({ type: "close", generation: current }));
      }
    });
  });
  await withEnvironment({ command: process.execPath,
    args: [fileURLToPath(new URL("../.github/actions/agent-runtime/fixtures/agent.ts", import.meta.url))],
    workspace: process.cwd(), env: {} }, "codex", deadline, { GH_TOKEN: "fixture-work-token" }, {
    sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  }, environment => serveEnvironmentConnections(environment, deadline, signal =>
    connectEnvironment(new URL(`ws://127.0.0.1:${address.port}/connect`),
      "00000000-0000-4000-8000-000000000001", async () => "fixture", signal)));
  const value = await result.promise as { ok: boolean; value: { finalResponse: string } };
  assert.equal(value.ok, true);
  assert.equal(JSON.parse(value.value.finalResponse).structuredContent.conclusion, "success");
  assert.equal(generation, reconnect ? 2 : 1);
  assert.equal(registrations, generation);
  assert.equal(waitIds.size, 1); assert.equal(reads, 1);
});

for (const mode of ["resume", "deadline-change", "generation-replay"] as const) {
  test(`connection owner retains the Environment and rejects identity changes: ${mode}`, { timeout: 7000 }, async t => {
    const deadline = Date.now() + 5000;
    const controller = new AbortController();
    const neverExecute = async (): Promise<never> => { throw new Error("Unexpected execution"); };
    const environment: EnvironmentPort = { signal: controller.signal, execute: neverExecute, cancel: neverExecute,
      inputs: new EnvironmentInput(), ciWaits: new EnvironmentCiWaits(),
      output: new EnvironmentOutput(),
      command: neverExecute, agent: neverExecute, close: async () => { controller.abort(); } };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      controller.abort();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let connections = 0;
    let tokens = 0;
    server.on("connection", socket => {
      const attempt = ++connections;
      const generation = mode === "generation-replay" ? 1 : attempt;
      socket.send(JSON.stringify({ type: "connected", generation,
        deadline: mode === "deadline-change" ? deadline + 1 : deadline }));
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "ready-accepted" }));
        if (attempt === 1) socket.close(1000);
        else socket.send(JSON.stringify({ type: "close", generation }));
      });
    });
    const serving = serveEnvironmentConnections(environment, deadline, signal => {
      assert.equal(environment.signal.aborted, false);
      return connectEnvironment(new URL(`ws://127.0.0.1:${address.port}/connect`),
        "00000000-0000-4000-8000-000000000001", async () => `token-${++tokens}`, signal);
    });
    if (mode === "resume") await serving;
    else await assert.rejects(serving, { message: "ENVIRONMENT_CONNECTION_IDENTITY_CHANGED" });
    assert.equal(connections, mode === "deadline-change" ? 1 : 2);
    assert.equal(tokens, connections);
    assert.equal(environment.signal.aborted, true);
  });
}

test("runner uses fresh header credentials, validates handshake and reports transport closure", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `ws://127.0.0.1:${address.port}`;
  const runtimeId = "00000000-0000-4000-8000-000000000001";
  let tokens = 0;
  let connections = 0;
  server.on("connection", (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, `Bearer fixture-${connections}`);
    assert.equal(request.headers["x-harness-runtime-id"], runtimeId);
    assert.doesNotMatch(request.url!, /fixture/);
    socket.send(JSON.stringify({ type: "connected", generation: connections,
      deadline: request.url === "/expired" ? 1 : Date.now() + 60000 }));
    socket.on("message", () => socket.close(1000));
  });
  const token = async () => `fixture-${++tokens}`;
  for (let generation = 1; generation <= 2; generation++) {
    const connection = await connectEnvironment(new URL(`${origin}/connect`), runtimeId, token, AbortSignal.timeout(3000));
    assert.equal(connection.generation, generation);
    connection.socket.send(JSON.stringify({ type: "ready" }));
    assert.deepEqual(await connection.closed, { code: 1000 });
  }
  await assert.rejects(connectEnvironment(new URL(`${origin}/expired`), runtimeId, token, AbortSignal.timeout(3000)), /ENVIRONMENT_CONNECTION_FAILED/);
  const count = tokens;
  await assert.rejects(connectEnvironment(new URL("ws://external.example/connect"), runtimeId, token, AbortSignal.timeout(3000)), /INVALID_ENVIRONMENT_CONNECTION/);
  await assert.rejects(connectEnvironment(new URL(`${origin}/connect`), runtimeId, token, AbortSignal.abort()));
  assert.equal(tokens, count);
});

for (const completion of ["after-reconnect", "while-disconnected"] as const)
test(`socket loss preserves one execution and result: completion=${completion}`, { timeout: 7000 }, async t => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-channel-"));
  const runtime = new EnvironmentRuntime({ workspace, deadline: Date.now() + 5000, env: {} });
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const duplicateSeen = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let executions = 0;
  let deliveries = 0;
  const environment: EnvironmentPort = {
    inputs: new EnvironmentInput(), ciWaits: new EnvironmentCiWaits(),
    get output() { return operations.output; },
    cancel: id => operations.cancel(id),
    signal: controller.signal,
    close: async () => { controller.abort(); await runtime.close(); },
    command: async input => { executions++; started.resolve(); await release.promise; return runtime.command(input); },
    agent: async () => { throw new Error("must not call model"); },
    execute: (id, input) => {
      if (++deliveries === 2) duplicateSeen.resolve();
      return operations.execute(id, input).then(result => { completed.resolve(); return result; });
    },
  };
  const operations = new EnvironmentOperations(environment, () => runtime.cancelActive());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    release.resolve();
    await environment.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(workspace, { recursive: true });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`ws://127.0.0.1:${address.port}/connect`);
  const runtimeId = "00000000-0000-4000-8000-000000000001";
  let generation = 0;
  const received = Promise.withResolvers<unknown>();
  server.on("connection", socket => {
    const current = ++generation;
    socket.send(JSON.stringify({ type: "connected", generation: current, deadline: Date.now() + 5000 }));
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.type === "ready") {
        socket.send(JSON.stringify({ type: "ready-accepted" }));
        if (current === 3) {
          socket.send(JSON.stringify({ type: "close", generation: current }));
          return;
        }
        socket.send(JSON.stringify({ type: "execute", generation: current, taskId: "once", input: {
          kind: "command", argv: [process.execPath, "-e", "require('node:fs').appendFileSync('count','x');process.stdout.write('done')"], timeoutSeconds: 3,
        } }));
      } else if (message.type === "result") { received.resolve(message); socket.close(1000); }
    });
  });
  const first = await connectEnvironment(url, runtimeId, async () => "fixture", AbortSignal.timeout(2000));
  const firstServing = serveEnvironmentConnection(first, environment, () => generation);
  await started.promise;
  first.socket.terminate();
  await firstServing;
  assert.equal(environment.signal.aborted, false);
  if (completion === "while-disconnected") {
    release.resolve();
    await completed.promise;
    assert.equal(await readFile(join(workspace, "count"), "utf8"), "x");
  }
  const second = await connectEnvironment(url, runtimeId, async () => "fixture", AbortSignal.timeout(2000));
  const secondServing = serveEnvironmentConnection(second, environment, () => generation);
  await duplicateSeen.promise;
  release.resolve();
  const result = await received.promise;
  assert.ok(result && typeof result === "object" && "generation" in result && result.generation === 2);
  await secondServing;
  assert.equal(executions, 1);
  assert.equal(await readFile(join(workspace, "count"), "utf8"), "x");
  assert.equal(environment.signal.aborted, false);
  const third = await connectEnvironment(url, runtimeId, async () => "fixture", AbortSignal.timeout(2000));
  await serveEnvironmentConnection(third, environment, () => generation);
  assert.equal(environment.signal.aborted, true);
  await assert.rejects(runtime.command({ argv: [process.execPath, "-e", ""], timeoutSeconds: 1 }),
    { message: "ENVIRONMENT_RUNTIME_CLOSING" });
});
