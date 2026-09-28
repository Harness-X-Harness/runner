import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { internalEnvironmentFetch, ENVIRONMENT_WORKFLOW } from "../apps/chatgpt-app/src/environment-callback.ts";

const { generateKeyPair, SignJWT }: typeof import("../apps/chatgpt-app/node_modules/jose/dist/types/index.js") =
  createRequire(new URL("../apps/chatgpt-app/package.json", import.meta.url))("jose");

test("Environment claim verifies workflow OIDC and ignores caller-supplied identity", async () => {
  const key = await generateKeyPair("RS256");
  const origin = "https://runner.example";
  const repository = "example/runner";
  const environmentId = `env_${"a".repeat(32)}`;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://token.actions.githubusercontent.com", aud: origin,
    iat: now, nbf: now - 5, exp: now + 300, repository,
    workflow_ref: `${repository}/.github/workflows/${ENVIRONMENT_WORKFLOW}@refs/heads/main`,
    ref: "refs/heads/main", ref_protected: "true", event_name: "workflow_dispatch",
    runner_environment: "github-hosted", actor_id: "123", run_id: "500", run_attempt: "1" };
  const received: unknown[] = [];
  const env = { TASK_CONTROL_PLANE_URL: origin, GITHUB_RUNNER_REPOSITORY: repository,
    ENVIRONMENTS: { getByName(name: string) {
      assert.equal(name, environmentId);
      return { async claimRuntime(value: unknown, token: string) {
          assert.equal(token, "PRIVATE_JOB_TOKEN");
          received.push(value); return { decision: "bound" as const, executor: "codex" as const, deadline: 123456789 };
        },
        async fetch(request: Request) {
          received.push(JSON.parse(request.headers.get("x-harness-runtime-claim")!));
          assert.equal(request.headers.get("authorization"), null);
          assert.equal(request.headers.get("x-harness-github-token"), null);
          return Response.json({ forwarded: true });
        } };
    } },
  };
  const call = async (overrides: Record<string, unknown> = {}, connect = false) => {
    const token = await new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256" }).sign(key.privateKey);
    return internalEnvironmentFetch(new Request(`${origin}/internal/environments/${environmentId}/${connect ? "connect" : "claim"}`, {
      method: connect ? "GET" : "POST", headers: { authorization: `Bearer ${token}`,
        "x-harness-github-token": "PRIVATE_JOB_TOKEN",
        upgrade: "websocket", "x-harness-runtime-id": "00000000-0000-4000-8000-000000000001",
        "x-harness-runtime-claim": JSON.stringify({ ownerId: "attacker", runId: "999" }),
      },
      ...(connect ? {} : { body: JSON.stringify({ ownerId: "attacker", runId: "999", runAttempt: "999" }) }),
    }), env, () => key.publicKey);
  };
  for (const change of [{ exp: now - 1 }, { aud: "https://other.example" },
    { workflow_ref: `${repository}/.github/workflows/run-task.yml@refs/heads/main` },
    { ref_protected: "false" }, { event_name: "pull_request" }, { actor_id: "" }]) {
    assert.equal((await call(change)).status, 401);
    assert.equal((await call(change, true)).status, 401);
  }
  assert.deepEqual(received, []);
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { decision: "bound", executor: "codex", deadline: 123456789 });
  assert.deepEqual(received, [{ ownerId: "123", repository, runId: "500", runAttempt: "1" }]);
  assert.equal((await call({}, true)).status, 200);
  assert.deepEqual(received[1], { ownerId: "123", repository, runId: "500", runAttempt: "1",
    runtimeId: "00000000-0000-4000-8000-000000000001" });
});
