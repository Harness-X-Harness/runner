import assert from "node:assert/strict";
import test from "node:test";
import { ContextPublisher } from "../apps/chatgpt-app/ui/context-publisher.ts";
import { readView, parseCommandDraft, decidePromptSend, selectedOperationArguments } from "../apps/chatgpt-app/ui/view.ts";
const environmentId = `env_${"a".repeat(32)}`;
const view = readView({ structuredContent: { contract: "ordinary", environmentId, executor: "codex", environmentStatus: "ready", disposition: "accepted", workFinished: false, expiresAt: null } }, 1);

test("explicit context needs capability and acknowledgement; duplicates are per card", async () => {
  const publisher = new ContextPublisher();
  const deliveries: unknown[] = [];
  const send = async (context: unknown) => { deliveries.push(context); return {}; };
  assert.equal(await publisher.publish(view, false, send), "unsupported");
  assert.equal(await publisher.publish(undefined, true, send), "unavailable");
  assert.equal(deliveries.length, 0);
  assert.equal(await publisher.publish(view, true, async () => ({ isError: true })), "failed");
  assert.equal(await publisher.publish(view, true, async () => { throw new Error("host failure"); }), "failed");
  assert.equal(await publisher.publish(view, true, send), "sent");
  assert.equal(await publisher.publish({ ...view, receivedAt: 9999 }, true, send), "duplicate");
  assert.deepEqual(deliveries, [{ content: [{ type: "text", text: `AgentEnv selection: environmentId=${environmentId}` }] }]);
  // Independent views cannot assert a shared global selection or ordering.
  assert.equal(await new ContextPublisher().publish(view, true, send), "sent");
});

test("pending explicit context is suppressed; failed delivery can retry", async () => {
  const publisher = new ContextPublisher();
  let resolve!: (value: { isError?: boolean }) => void;
  const pending = publisher.publish(view, true, () => new Promise(done => { resolve = done; }));
  assert.equal(await publisher.publish(view, true, async () => assert.fail("duplicate pending")), "pending");
  resolve({ isError: true });
  assert.equal(await pending, "failed");
  assert.equal(await publisher.publish(view, true, async () => ({})), "sent");
});

test("command composer preserves literal argv and bounds JSON, timeout and retry identity", () => {
  const parsed = parseCommandDraft('["printf", "$(never-expanded)", "a b", ""]', 30);
  assert.deepEqual(parsed, { argv: ["printf", "$(never-expanded)", "a b", ""], cwd: ".", timeoutSeconds: 30 });
  for (const input of ['git status', '[]', '[""]', '[1]', '["a\\u0000"]', JSON.stringify(Array(65).fill("x")), JSON.stringify(["x".repeat(8193)])]) assert.throws(() => parseCommandDraft(input, 30));
  for (const timeout of [0, 301, 1.1, NaN]) assert.throws(() => parseCommandDraft('["pwd"]', timeout));
  const first = decidePromptSend(undefined, environmentId, JSON.stringify(parsed), "first");
  if (first.action !== "send") return assert.fail();
  const retry = decidePromptSend(first.lease, environmentId, JSON.stringify(parsed), "second");
  assert.equal(retry.action === "send" && retry.key, "first");
  assert.equal(decidePromptSend(first.lease, environmentId, JSON.stringify({ ...parsed, timeoutSeconds: 31 }), "third").action, "blocked");
  const operationId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
  assert.deepEqual(selectedOperationArguments(environmentId, operationId), { environmentId, operationId });
  assert.equal(selectedOperationArguments(environmentId, `task_${"c".repeat(32)}_${"b".repeat(32)}`), undefined);
});
