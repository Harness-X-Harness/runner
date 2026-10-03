import assert from "node:assert/strict";
import test from "node:test";
import { PreviewSession, scenes } from "../apps/chatgpt-app/preview/scenarios.ts";
import { readView } from "../apps/chatgpt-app/ui/view.ts";
import { startPreview } from "../apps/chatgpt-app/preview/server.ts";
import { buildWorkbench } from "../apps/chatgpt-app/build-ui.ts";

test("local preview serves the production artifact, not a second card implementation", async () => {
  const { server, url } = await startPreview(0);
  try {
    const response = await fetch(`${url}/workbench`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await buildWorkbench());
    assert.match(response.headers.get("content-security-policy")!, /connect-src 'none'/);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(`${url}/mcp`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${url}/.secrets.env`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("every preview scene is accepted by the production display contract", () => {
  for (const scene of scenes) {
    for (const executor of ["codex", "grok"] as const) {
      const session = new PreviewSession(scene.id, executor, 1000);
      assert.doesNotThrow(() => readView(session.initial(), 1000), scene.id);
    }
  }
});

test("preview open and send advance only when the user reads progress", () => {
  const session = new PreviewSession("empty", "codex", 1000);
  const call = (name: string, args = {}) => readView(session.call(name, args), 1000);
  const opened = call("open_environment", { executor: "grok", idempotencyKey: "open" });
  assert.equal(opened.kind, "environment");
  if (opened.kind !== "environment") return;
  assert.equal(opened.snapshot.environmentStatus, "opening");
  const ready = call("inspect_environment");
  assert.equal(ready.kind === "environment" && ready.snapshot.environmentStatus, "ready");
  const started = call("agent", { prompt: "hello", idempotencyKey: "send" });
  assert.equal(started.kind === "environment" && started.snapshot.operationStatus, "working");
  const result = call("inspect_environment");
  assert.equal(result.kind === "environment" && result.snapshot.operationStatus, "completed");
  assert.equal(result.kind === "environment" && result.snapshot.executor, "grok");
  call("close_environment");
  const closed = call("inspect_environment");
  assert.equal(closed.kind === "environment" && closed.snapshot.environmentStatus, "closed");
  assert.deepEqual(call("list_environments"), { kind: "list", environments: [], receivedAt: 1000 });
});
