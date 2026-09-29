import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentOperations } from "../.github/actions/agent-runtime/environment-operations.ts";
import type { EnvironmentPort } from "../.github/actions/agent-runtime/environment.ts";

test("duplicate delivery shares execution and replays an immutable result after close", async () => {
  const completed = Promise.withResolvers<Awaited<ReturnType<EnvironmentPort["command"]>>>();
  const lifetime = new AbortController();
  let executions = 0;
  const operations = new EnvironmentOperations({ signal: lifetime.signal, close: async () => {},
    agent: async () => { throw new Error("must not call model"); },
    command: async () => { executions++; return completed.promise; },
  }, async () => {});
  const input = { kind: "command", argv: ["fixture"], timeoutSeconds: 5 };
  const first = operations.execute("one", input);
  const duplicate = operations.execute("one", { ...input, cwd: "." });
  await Promise.resolve();
  assert.equal(executions, 1);
  await assert.rejects(operations.execute("one", { ...input, argv: ["different"] }), /OPERATION_ID_CONFLICT/);
  completed.resolve({ exitCode: 7, signal: null, stdout: "once", stderr: "", truncated: false });
  const result = await first;
  assert.deepEqual(await duplicate, result);
  if (result.ok && "stdout" in result.value) result.value.stdout = "mutated";
  lifetime.abort();
  const replay = await operations.execute("one", input);
  assert.ok(replay.ok && "stdout" in replay.value && replay.value.stdout === "once");
  await assert.rejects(operations.execute("two", input), /ENVIRONMENT_RUNTIME_CLOSING/);
  assert.equal(executions, 1);
});

test("failure receipts do not expose diagnostics or evict replay protection", async () => {
  let executions = 0;
  const operations = new EnvironmentOperations({ signal: new AbortController().signal, close: async () => {},
    command: async () => { executions++; throw new Error("PRIVATE-fixture-diagnostic"); },
    agent: async () => ({ status: "completed", finalResponse: "unused", model: "gpt-6-sol", reasoningEffort: "high" }),
  }, async () => {});
  const input = { kind: "command", argv: ["fixture"], timeoutSeconds: 5 };
  for (let index = 0; index < 256; index++) {
    assert.deepEqual(await operations.execute(`op-${index}`, input), { ok: false, code: "OPERATION_FAILED" });
  }
  await assert.rejects(operations.execute("overflow", input), /OPERATION_RECEIPT_CAPACITY/);
  assert.deepEqual(await operations.execute("op-0", input), { ok: false, code: "OPERATION_FAILED" });
  assert.equal(executions, 256);
});
