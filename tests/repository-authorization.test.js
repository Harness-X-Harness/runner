import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  completeInstallationAuthorization,
  createInstallationRequest,
  resolveRepositoryAccess,
  startInstallationAuthorization,
} from "../apps/chatgpt-app/src/repository-authorization.js";
import {
  applyTaskEvent,
  claimTaskDispatch,
  commitTaskDispatch,
} from "../apps/chatgpt-app/src/task.js";
import { fakeAuthorizationStates } from "./helpers/authorization-state.js";

test("public analyze selects one public-read path without an installation lookup", async () => {
  const requests = [];
  const access = await resolveRepositoryAccess(
    {},
    { githubAccessToken: "user-token" },
    { repo: "upstream/project", ref: "main", mode: "analyze" },
    async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ private: false, permissions: { pull: true } });
    },
  );

  assert.deepEqual(access, {
    kind: "ready",
    repositoryAccess: "public_read",
  });
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://api.github.com/repos/upstream/project",
  ]);
});

test("write mode requests installation instead of falling back to public read", async () => {
  const requests = [];
  const access = await resolveRepositoryAccess(
    appEnvironment(),
    { githubAccessToken: "user-token" },
    { repo: "upstream/project", ref: "main", mode: "edit" },
    async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) {
        return Response.json({ private: false, permissions: { push: true } });
      }
      return new Response("not installed", { status: 404 });
    },
  );

  assert.deepEqual(access, {
    kind: "installation_required",
    requiredPermissions: ["contents:write"],
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1].init.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
});

test("private analyze uses only a sufficient verified installation", async () => {
  const access = await resolveRepositoryAccess(
    appEnvironment(),
    { githubAccessToken: "user-token" },
    { repo: "owner/private", ref: "main", mode: "analyze" },
    async (url) => {
      if (String(url).endsWith("/repos/owner/private")) {
        return Response.json({ private: true, permissions: { pull: true } });
      }
      return Response.json({
        id: 99,
        permissions: { contents: "write", pull_requests: "write" },
      });
    },
  );

  assert.deepEqual(access, {
    kind: "ready",
    repositoryAccess: "installation",
  });
});

test("unknown GitHub responses fail naturally and never select another path", async () => {
  await assert.rejects(
    resolveRepositoryAccess(
      appEnvironment(),
      { githubAccessToken: "user-token" },
      { repo: "owner/project", ref: "main", mode: "analyze" },
      async () => new Response("unavailable", { status: 503 }),
    ),
    /repository lookup failed with 503/,
  );
});

test("installation request stores opaque task state and returns one Worker action", async () => {
  const states = fakeAuthorizationStates();
  const authorization = await createInstallationRequest(
    {
      TASK_CONTROL_PLANE_URL: "https://runner.example.com",
      AUTHORIZATION_STATES: states.binding,
    },
    { id: "task_123", ownerId: "42" },
  );

  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.origin, "https://runner.example.com");
  assert.equal(url.pathname, "/github/install");
  assert.match(url.searchParams.get("state"), /^repo_install_/);
  assert.equal(states.size(), 1);
  assert.deepEqual(states.get(`github:install:${url.searchParams.get("state")}`), {
    taskId: "task_123",
    ownerId: "42",
  });
});

test("installation action requests GitHub installation only while access is missing", async () => {
  const taskState = fakeTaskState(waitingTask());
  const state = "repo_install_original";
  const states = fakeAuthorizationStates([
    [`github:install:${state}`, { taskId: "task_123", ownerId: "42" }],
  ]);
  const response = await startInstallationAuthorization(
    new Request(`https://runner.example.com/github/install?state=${state}`),
    {
      ...appEnvironment(),
      GITHUB_APP_SLUG: "harness-x-harness-task-runner",
      AUTHORIZATION_STATES: states.binding,
      TASKS: taskState.binding,
    },
    async () => new Response("not installed", { status: 404 }),
  );

  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://github.com");
  assert.equal(
    location.pathname,
    "/apps/harness-x-harness-task-runner/installations/new",
  );
  assert.equal(location.searchParams.get("state"), state);
  assert.match(response.headers.get("set-cookie"), /__Host-RUNNER_INSTALL_STATE=/);
});

test("installation return starts original-user verification before dispatch", async () => {
  const taskState = fakeTaskState(waitingTask());
  const state = "repo_install_original";
  const states = fakeAuthorizationStates([
    [`github:install:${state}`, { taskId: "task_123", ownerId: "42" }],
  ]);
  const response = await startInstallationAuthorization(
    new Request(`https://runner.example.com/github/install?state=${state}`),
    {
      ...appEnvironment(),
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      AUTHORIZATION_STATES: states.binding,
      TASKS: taskState.binding,
    },
    async () => Response.json({
      id: 88,
      permissions: { contents: "write" },
    }),
  );

  const location = new URL(response.headers.get("location"));
  const oauthState = location.searchParams.get("state");
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.pathname, "/login/oauth/authorize");
  assert.match(oauthState, /^install_oauth_/);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.match(location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  const oauthRecord = states.get(`github:oauth:${oauthState}`);
  assert.deepEqual(oauthRecord.payload, {
    kind: "installation",
    taskId: "task_123",
    ownerId: "42",
    installState: state,
  });
  assert.match(oauthRecord.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(oauthRecord.browserBindingHash, /^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers.get("set-cookie"), /__Host-RUNNER_GITHUB_STATE=/);
});

test("dispatch claim is single-use and a late commit cannot regress running", () => {
  const waiting = {
    id: "task_123",
    status: "awaiting_installation",
    authorizationUrl: "https://runner.example.com/github/install?state=secret",
    requiredPermissions: ["contents:read"],
  };
  const first = claimTaskDispatch(waiting, "installation");
  const second = claimTaskDispatch(first.task, "installation");

  assert.equal(first.claimed, true);
  assert.equal(first.task.status, "dispatching");
  assert.equal(first.task.repositoryAccess, "installation");
  assert.equal(first.task.authorizationUrl, undefined);
  assert.equal(second.claimed, false);
  assert.equal(commitTaskDispatch({ ...first.task, status: "running" }).status, "running");
  assert.throws(
    () => claimTaskDispatch(waiting, "public_read"),
    /require verified installation access/,
  );
});

test("verified installation callback dispatches once and duplicate callback cannot revive it", async () => {
  const taskState = fakeTaskState({
    id: "task_123",
    repo: "owner/private",
    ref: "main",
    prompt: "Analyze the repository",
    executor: "codex",
    mode: "analyze",
    ownerId: "42",
    runnerRepository: "Harness-X-Harness/runner",
    status: "awaiting_installation",
    createdAt: "2026-08-15T00:00:00.000Z",
    authorizationUrl: "https://runner.example.com/github/install?state=repo_install_original",
    requiredPermissions: ["contents:read"],
  });
  const states = fakeAuthorizationStates([
    ["github:install:repo_install_original", {
      taskId: "task_123",
      ownerId: "42",
    }],
  ]);
  let dispatches = 0;
  const env = {
    ...appEnvironment(),
    GITHUB_APP_CLIENT_ID: "Iv1.example",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
    GITHUB_WORKFLOW_ID: "execute-task.yml",
    GITHUB_RUNNER_REF: "main",
    AUTHORIZATION_STATES: states.binding,
    TASKS: taskState.binding,
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "user-token" });
    }
    if (value === "https://api.github.com/user") {
      return Response.json({ id: 42, login: "owner" });
    }
    if (value.endsWith("/repos/owner/private")) {
      return Response.json({ private: true, permissions: { pull: true } });
    }
    if (value.endsWith("/repos/owner/private/installation")) {
      return Response.json({ id: 88, permissions: { contents: "write" } });
    }
    if (value.endsWith("/repos/Harness-X-Harness/runner/installation")) {
      return Response.json({ id: 99 });
    }
    if (value.endsWith("/app/installations/99/access_tokens")) {
      return Response.json({ token: "runner-token" });
    }
    if (value.endsWith("/actions/workflows/execute-task.yml/dispatches")) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const authorization = {
    code: "github-code",
    callback: "https://runner.example.com/github/callback",
    codeVerifier: "verifier-123",
    payload: {
      kind: "installation",
      taskId: "task_123",
      ownerId: "42",
      installState: "repo_install_original",
    },
  };

  const first = await completeInstallationAuthorization(env, authorization, fetchImpl);
  const duplicate = await completeInstallationAuthorization(env, authorization, fetchImpl);

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(dispatches, 1);
  assert.equal(taskState.current().status, "queued");
  assert.equal(taskState.current().repositoryAccess, "installation");
  assert.equal(states.has("github:install:repo_install_original"), false);
});

function appEnvironment() {
  return {
    GITHUB_APP_ID: "4385224",
    GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
  };
}

function testPrivateKeyPem() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

function fakeTaskState(initial) {
  let task = structuredClone(initial);
  const stub = {
    async fetch(input, init = {}) {
      const path = new URL(input).pathname;
      if (path === "/task" && (!init.method || init.method === "GET")) {
        return Response.json(task);
      }
      if (path === "/task" && init.method === "PATCH") {
        task = applyTaskEvent(task, JSON.parse(init.body));
        return Response.json(task);
      }
      if (path === "/task/claim-dispatch" && init.method === "POST") {
        const result = claimTaskDispatch(
          task,
          JSON.parse(init.body).repositoryAccess,
        );
        task = result.task;
        return Response.json(result);
      }
      if (path === "/task/commit-dispatch" && init.method === "POST") {
        task = commitTaskDispatch(task);
        return Response.json(task);
      }
      return new Response("not found", { status: 404 });
    },
  };
  return {
    binding: {
      idFromName: (id) => id,
      get: () => stub,
    },
    current: () => structuredClone(task),
  };
}

function waitingTask() {
  return {
    id: "task_123",
    repo: "owner/private",
    ref: "main",
    prompt: "Analyze the repository",
    executor: "codex",
    mode: "analyze",
    ownerId: "42",
    runnerRepository: "Harness-X-Harness/runner",
    status: "awaiting_installation",
    createdAt: "2026-08-15T00:00:00.000Z",
    authorizationUrl: "https://runner.example.com/github/install?state=repo_install_original",
    requiredPermissions: ["contents:read"],
  };
}
