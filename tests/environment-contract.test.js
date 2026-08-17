import assert from "node:assert/strict";
import test from "node:test";

import {
  closeEnvironment,
  openEnvironment,
  reconcileEnvironment,
} from "../apps/chatgpt-app/src/environment.js";
import { publishEnvironmentReady } from "../apps/chatgpt-app/src/environment-callback.js";
import { completeAuthorizationCallback } from "../apps/chatgpt-app/src/authorization.js";
import {
  completeEnvironmentAuthorization,
  environmentEntry,
} from "../apps/chatgpt-app/src/environment-page.js";
import { fakeAuthorizationStates } from "./helpers/authorization-state.js";
import { trustedRunnerClaims } from "../apps/chatgpt-app/src/runner-identity.js";

test("ready OIDC accepts only the exact repository, workflow, ref, and run", () => {
  const env = {
    GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
    GITHUB_RUNNER_REF: "main",
  };
  const claims = {
    repository: "Harness-X-Harness/runner",
    workflow_ref: "Harness-X-Harness/runner/.github/workflows/private-runner-session.yml@refs/heads/main",
    run_id: "123456",
  };
  assert.equal(
    trustedRunnerClaims(claims, env, "private-runner-session.yml"),
    claims,
  );
  for (const altered of [
    { ...claims, repository: "attacker/fork" },
    { ...claims, workflow_ref: claims.workflow_ref.replace("private-runner-session", "execute-task") },
    { ...claims, workflow_ref: claims.workflow_ref.replace("main", "feature") },
    { ...claims, run_id: "" },
  ]) {
    assert.throws(
      () => trustedRunnerClaims(altered, env, "private-runner-session.yml"),
      /not trusted/,
    );
  }
});

test("Environment identity reports the failing GitHub stage without upstream details", async () => {
  const authorization = {
    code: "github-code",
    callback: "https://runner.example/github/callback",
    codeVerifier: "verifier",
  };
  const env = {
    GITHUB_APP_CLIENT_ID: "Iv1.example",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
  };
  const tokenFailure = await completeEnvironmentAuthorization(
    env,
    authorization,
    async () => Response.json(
      { error: "private upstream detail" },
      { status: 400 },
    ),
    { error() {} },
  );
  assert.equal(await tokenFailure.text(), "GitHub token exchange failed");

  const profileFailure = await completeEnvironmentAuthorization(
    env,
    authorization,
    async (url) => url === "https://github.com/login/oauth/access_token"
      ? Response.json({ access_token: "ghu_access" })
      : Response.json(
        { message: "private upstream detail" },
        { status: 403 },
      ),
    { error() {} },
  );
  assert.equal(await profileFailure.text(), "GitHub profile lookup failed");
});

test("one GitHub user opens one Environment and repeated open returns it", async () => {
  const environments = fakeEnvironments();
  const dispatches = [];
  const env = {
    ENVIRONMENTS: environments.binding,
    TASK_CONTROL_PLANE_URL: "https://runner.example",
  };
  const dispatch = async (_env, request) => {
    dispatches.push(request);
    return {
      runId: "123456",
      runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123456",
    };
  };

  const first = await openEnvironment(env, "42", dispatch, () => "generation-one");
  const second = await openEnvironment(
    env,
    "42",
    dispatch,
    () => "generation-two",
    async () => {},
    async () => ({ status: "in_progress" }),
  );

  assert.deepEqual(first, {
    status: "starting",
    environmentUrl: "https://runner.example/environment",
    runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123456",
  });
  assert.deepEqual(second, first);
  assert.deepEqual(dispatches, [{ environmentId: "generation-one" }]);
  assert.equal(environments.get("github-42").generation, "generation-one");
});

test("an uncertain dispatch failure holds the owner instead of risking a second run", async () => {
  const environments = fakeEnvironments();
  const env = {
    ENVIRONMENTS: environments.binding,
    TASK_CONTROL_PLANE_URL: "https://runner.example",
  };
  await assert.rejects(
    openEnvironment(
      env,
      "42",
      async () => { throw new Error("GitHub unavailable"); },
      () => "generation-one",
    ),
    /GitHub unavailable/,
  );
  assert.equal(environments.get("github-42").status, "dispatching");
  const held = await openEnvironment(
    env,
    "42",
    async () => { throw new Error("must not dispatch twice"); },
    () => "generation-two",
  );
  assert.equal(held.status, "starting");
  assert.equal(environments.get("github-42").generation, "generation-one");
});

test("the stable Environment entry verifies GitHub identity before showing Preparing", async () => {
  const environments = fakeEnvironments();
  await openEnvironment(
    {
      ENVIRONMENTS: environments.binding,
      TASK_CONTROL_PLANE_URL: "https://runner.example",
      ENVIRONMENT_SESSION_SECRET: "environment-session-secret",
    },
    "42",
    async () => ({
      runId: "123456",
      runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123456",
    }),
  );
  const states = fakeAuthorizationStates();
  const env = {
    ENVIRONMENTS: environments.binding,
    AUTHORIZATION_STATES: states.binding,
    GITHUB_APP_CLIENT_ID: "Iv1.example",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    ENVIRONMENT_SESSION_SECRET: "environment-session-secret",
    TASK_CONTROL_PLANE_URL: "https://runner.example",
  };

  const login = await environmentEntry(
    new Request("https://runner.example/environment"),
    env,
  );
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("cache-control"), "no-store");
  assert.equal(login.headers.get("referrer-policy"), "no-referrer");
  assert.equal(login.headers.get("x-frame-options"), "DENY");
  const github = new URL(login.headers.get("location"));
  assert.equal(github.origin, "https://github.com");
  assert.equal(github.searchParams.get("code_challenge_method"), "S256");
  const state = github.searchParams.get("state");
  assert.equal(states.get(`github:oauth:${state}`).payload.kind, "environment");

  const githubCookie = cookieFromResponse(login, "__Host-RUNNER_GITHUB_STATE");
  const callback = await completeAuthorizationCallback(
    new Request(
      `https://runner.example/github/callback?state=${state}&code=github-code`,
      { headers: { cookie: `__Host-RUNNER_GITHUB_STATE=${githubCookie}` } },
    ),
    env,
    async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "ghu_access" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 42, login: "owner" });
      }
      return new Response("unexpected request", { status: 500 });
    },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "https://runner.example/environment");
  const environmentCookie = cookieFromResponse(
    callback,
    "__Host-RUNNER_ENVIRONMENT",
  );

  const preparing = await environmentEntry(
    new Request("https://runner.example/environment", {
      headers: { cookie: `__Host-RUNNER_ENVIRONMENT=${environmentCookie}` },
    }),
    env,
    async () => ({ status: "in_progress" }),
  );
  assert.equal(preparing.status, 200);
  assert.equal(preparing.headers.get("cache-control"), "no-store");
  assert.equal(preparing.headers.get("referrer-policy"), "no-referrer");
  assert.equal(preparing.headers.get("x-frame-options"), "DENY");
  const body = await preparing.text();
  assert.match(body, /Preparing private development environment/);
  assert.match(body, /http-equiv="refresh" content="10"/);
  assert.match(body, /actions\/runs\/123456/);
  assert.doesNotMatch(body, /trycloudflare|pairing|secret/i);

  const generation = environments.get("github-42").generation;
  const ready = await publishEnvironmentReady(env, generation, "123456", {
    t3Url: "https://quick-tunnel.example",
    pairingUrl: "https://quick-tunnel.example/pair#token=private",
    tailscaleHost: "gha-123456-1",
  });
  assert.equal(ready.status, 200);
  const invalidDescriptor = await publishEnvironmentReady(env, generation, "123456", {
    t3Url: "https://quick-tunnel.example",
    pairingUrl: "javascript:alert(1)",
    tailscaleHost: "gha-123456-1",
  });
  assert.equal(invalidDescriptor.status, 400);
  const publicReady = await openEnvironment(
    env,
    "42",
    async () => { throw new Error("must not dispatch a second run"); },
    () => "ignored-generation",
    async () => {},
    async () => ({ status: "in_progress" }),
  );
  assert.deepEqual(publicReady, {
    status: "ready",
    environmentUrl: "https://runner.example/environment",
    runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123456",
  });
  assert.doesNotMatch(JSON.stringify(publicReady), /quick-tunnel|pair|tailscale|token/i);

  const otherAuthorization = await completeEnvironmentAuthorization(
    env,
    {
      code: "other-user-code",
      callback: "https://runner.example/github/callback",
      codeVerifier: "other-user-verifier",
    },
    async (url) => url === "https://github.com/login/oauth/access_token"
      ? Response.json({ access_token: "ghu_other" })
      : Response.json({ id: 43, login: "other" }),
  );
  const otherCookie = cookieFromResponse(otherAuthorization, "__Host-RUNNER_ENVIRONMENT");
  const otherEntry = await environmentEntry(
    new Request("https://runner.example/environment", {
      headers: { cookie: `__Host-RUNNER_ENVIRONMENT=${otherCookie}` },
    }),
    env,
  );
  assert.equal(otherEntry.status, 200);
  assert.match(await otherEntry.text(), /environment is offline/i);
  const pairing = await environmentEntry(
    new Request("https://runner.example/environment", {
      headers: { cookie: `__Host-RUNNER_ENVIRONMENT=${environmentCookie}` },
    }),
    env,
    async () => ({ status: "in_progress" }),
  );
  assert.equal(pairing.status, 302);
  assert.equal(
    pairing.headers.get("location"),
    "https://quick-tunnel.example/pair#token=private",
  );
  assert.equal(pairing.headers.get("referrer-policy"), "no-referrer");
  const cancelled = [];
  assert.equal((await closeEnvironment(env, "42", async (_env, runId) => {
    cancelled.push(runId);
  }, async () => ({ status: "in_progress" }))).status, "closing");
  assert.deepEqual(cancelled, ["123456"]);
  assert.equal(environments.get("github-42").pairingUrl, undefined);

  await openEnvironment(env, "84", async () => ({
    runId: "840000",
    runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/840000",
  }));
  const directGeneration = environments.get("github-84").generation;
  assert.equal((await publishEnvironmentReady(env, directGeneration, "840000", {
    t3Url: "https://second-tunnel.example",
    pairingUrl: "https://second-tunnel.example/pair#token=private",
    tailscaleHost: "gha-840000-1",
  })).status, 200);
  const reopenedAfterDirectCancel = await openEnvironment(
    env,
    "84",
    async () => ({
      runId: "850000",
      runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/850000",
    }),
    () => "generation-after-direct-cancel",
    async () => {},
    async () => ({ status: "completed", conclusion: "cancelled" }),
  );
  assert.equal(reopenedAfterDirectCancel.status, "starting");
  assert.equal(
    environments.get("github-84").generation,
    "generation-after-direct-cancel",
  );
  assert.equal(environments.get("github-84").pairingUrl, undefined);
});

test("closing cancels one exact run and a late ready callback cannot revive it", async () => {
  const environments = fakeEnvironments();
  const env = {
    ENVIRONMENTS: environments.binding,
    TASK_CONTROL_PLANE_URL: "https://runner.example",
    ENVIRONMENT_SESSION_SECRET: "environment-session-secret",
  };
  await openEnvironment(env, "42", async () => ({
    runId: "123456",
    runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123456",
  }));
  const generation = environments.get("github-42").generation;
  const wrongRun = await publishEnvironmentReady(env, generation, "999999", {
    t3Url: "https://quick-tunnel.example",
    pairingUrl: "https://quick-tunnel.example/pair#token=private",
    tailscaleHost: "gha-999999-1",
  });
  assert.equal(wrongRun.status, 409);
  const cancellations = [];
  const first = await closeEnvironment(env, "42", async (_env, runId) => {
    cancellations.push(runId);
  }, async () => ({ status: "in_progress" }));
  const second = await closeEnvironment(env, "42", async () => {
    throw new Error("must not cancel twice");
  }, async () => ({ status: "completed", conclusion: "cancelled" }));
  assert.equal(first.status, "closing");
  assert.deepEqual(second, { status: "offline" });
  assert.deepEqual(cancellations, ["123456"]);
  const late = await publishEnvironmentReady(env, generation, "123456", {
    t3Url: "https://quick-tunnel.example",
    pairingUrl: "https://quick-tunnel.example/pair#token=private",
    tailscaleHost: "gha-123456-1",
  });
  assert.equal(late.status, 409);
  assert.equal(environments.get("github-42").status, "offline");
  assert.equal(environments.get("github-42").pairingUrl, undefined);

  const offline = await reconcileEnvironment(
    env,
    "42",
    environments.get("github-42"),
    async (_env, runId) => {
      assert.equal(runId, "123456");
      return { status: "completed", conclusion: "cancelled" };
    },
  );
  assert.equal(offline.status, "offline");
  assert.equal(offline.pairingUrl, undefined);
  const oldGeneration = generation;
  await openEnvironment(env, "42", async () => ({
    runId: "654321",
    runUrl: "https://github.example/runs/654321",
  }));
  assert.notEqual(environments.get("github-42").generation, oldGeneration);
  const staleGeneration = await publishEnvironmentReady(env, oldGeneration, "123456", {
    t3Url: "https://old-tunnel.example",
    pairingUrl: "https://old-tunnel.example/pair#token=private",
    tailscaleHost: "gha-123456-1",
  });
  assert.equal(staleGeneration.status, 409);
  assert.deepEqual(await closeEnvironment(env, "43", async () => {}), {
    status: "offline",
  });
});

test("close during dispatch binds and cancels the run returned afterward", async () => {
  const environments = fakeEnvironments();
  const env = {
    ENVIRONMENTS: environments.binding,
    TASK_CONTROL_PLANE_URL: "https://runner.example",
  };
  let releaseDispatch;
  const dispatchReady = new Promise((resolve) => {
    releaseDispatch = resolve;
  });
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const cancellations = [];
  const opening = openEnvironment(
    env,
    "42",
    async () => {
      markStarted();
      await dispatchReady;
      return { runId: "123456", runUrl: "https://github.example/runs/123456" };
    },
    () => "generation-one",
    async (_env, runId) => cancellations.push(runId),
  );
  await started;
  assert.equal((await closeEnvironment(env, "42", async () => {})).status, "closing");
  releaseDispatch();
  assert.equal((await opening).status, "closing");
  assert.deepEqual(cancellations, ["123456"]);
  assert.equal(environments.get("github-42").runId, "123456");
});

function fakeEnvironments() {
  const records = new Map();
  return {
    binding: {
      idFromName: (name) => name,
      get: (ownerId) => ({
        fetch: async (input, init = {}) => {
          const path = new URL(input).pathname;
          const body = init.body ? JSON.parse(init.body) : undefined;
          if (path === "/environment" && (!init.method || init.method === "GET")) {
            const current = records.get(ownerId);
            return current
              ? Response.json(current)
              : Response.json({ error: "environment not found" }, { status: 404 });
          }
          if (path === "/environment/open" && init.method === "POST") {
            const current = records.get(ownerId);
            if (current && ["dispatching", "starting", "ready", "closing"].includes(current.status)) {
              return Response.json({ environment: current, dispatch: false });
            }
            const environment = {
              ownerId: body.ownerId,
              generation: body.generation,
              status: "dispatching",
            };
            records.set(ownerId, environment);
            return Response.json({ environment, dispatch: true }, { status: 201 });
          }
          if (path === "/environment/dispatch" && init.method === "POST") {
            const current = records.get(ownerId);
            if (!current || current.generation !== body.generation) {
              return Response.json({ error: "environment generation mismatch" }, { status: 409 });
            }
            if (current.status === "closing" && !current.runId) {
              const environment = {
                ...current,
                runId: String(body.runId),
                runUrl: body.runUrl,
              };
              records.set(ownerId, environment);
              return Response.json({ environment, cancel: true });
            }
            const environment = {
              ...current,
              status: "starting",
              runId: String(body.runId),
              runUrl: body.runUrl,
            };
            records.set(ownerId, environment);
            return Response.json({ environment, cancel: false });
          }
          if (path === "/environment/ready" && init.method === "POST") {
            const current = records.get(ownerId);
            if (
              !current ||
              current.generation !== body.generation ||
              current.runId !== body.runId ||
              current.status !== "starting"
            ) return Response.json({ error: "stale" }, { status: 409 });
            const environment = { ...current, ...body, status: "ready" };
            records.set(ownerId, environment);
            return Response.json(environment);
          }
          if (path === "/environment/close" && init.method === "POST") {
            const current = records.get(ownerId);
            if (!current || current.status === "offline") {
              return Response.json({ error: "not found" }, { status: 404 });
            }
            if (current.status === "closing") {
              return Response.json({ environment: current, cancel: false });
            }
            const environment = {
              ...current,
              status: "closing",
              pairingUrl: undefined,
              t3Url: undefined,
              tailscaleHost: undefined,
            };
            records.set(ownerId, environment);
            return Response.json({ environment, cancel: true });
          }
          if (path === "/environment/terminal" && init.method === "POST") {
            const current = records.get(ownerId);
            if (!current || current.runId !== body.runId) {
              return Response.json({ error: "mismatch" }, { status: 409 });
            }
            const environment = {
              ownerId: current.ownerId,
              generation: current.generation,
              runId: current.runId,
              runUrl: current.runUrl,
              status: "offline",
            };
            records.set(ownerId, environment);
            return Response.json(environment);
          }
          return new Response(null, { status: 404 });
        },
      }),
    },
    get: (ownerId) => records.get(ownerId),
  };
}

function cookieFromResponse(response, name) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")];
  for (const cookie of cookies) {
    const match = cookie?.match(new RegExp(`${name}=([^;,]*)`));
    if (match) return match[1];
  }
  throw new Error(`Missing cookie: ${name}`);
}
