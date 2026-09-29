import assert from "node:assert/strict";
import test from "node:test";
import { secureWorkerLogs } from "../apps/chatgpt-app/deploy.ts";

test("deployment preserves log configuration and confirms required privacy settings", async () => {
  let calls = 0;
  let stored: Record<string, unknown> = { enabled: true, logs: { head_sampling_rate: 0.5 } };
  await secureWorkerLogs("account", "worker", "PRIVATE_TOKEN", async (url, init) => {
    assert.equal(String(url), "https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/worker/settings");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer PRIVATE_TOKEN");
    calls++;
    if (init?.method === "PATCH") {
      assert.ok(init.body instanceof FormData);
      stored = JSON.parse(String(init.body.get("settings"))).observability;
    }
    return Response.json({ success: true, result: { observability: stored } });
  });
  assert.equal(calls, 3);
  assert.deepEqual(stored, { enabled: true, redact_query_string: true,
    logs: { head_sampling_rate: 0.5, invocation_logs: false }, traces: { enabled: false } });
});

test("unconfirmed privacy and API failures cannot report deployment success", async () => {
  await assert.rejects(secureWorkerLogs("a", "w", "PRIVATE_TOKEN", async () =>
    Response.json({ success: true, result: { observability: {} } })), /not confirmed/);
  const error = await secureWorkerLogs("a", "w", "PRIVATE_TOKEN", async () =>
    new Response("PRIVATE_UPSTREAM", { status: 403 })).catch(error => error);
  assert.match(error.message, /403/);
  assert.doesNotMatch(error.message, /PRIVATE/);
});
