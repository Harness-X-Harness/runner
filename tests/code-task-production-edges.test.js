import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import {
  dispatchEnvironmentWorkflow,
  dispatchWorkflow,
  EnvironmentDispatchError,
  getEnvironmentWorkflowRun,
} from "../apps/chatgpt-app/src/github.js";
import { resolveRepositoryAccess } from "../apps/chatgpt-app/src/repository-authorization.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("pull_request mode requires ref to resolve as a branch", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({ name: "feature/task" }), { status: 200 });
    }
    return Response.json({ permissions: { contents: "write", pull_requests: "write" } });
  };

  await resolveRepositoryAccess(
    {
      GITHUB_APP_ID: "4385224",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
    },
    { githubAccessToken: "token" },
    { repo: "owner/project", mode: "pull_request", ref: "feature/task" },
  );

  assert.deepEqual(requests, [
    "https://api.github.com/repos/owner/project",
    "https://api.github.com/repos/owner/project/branches/feature%2Ftask",
    "https://api.github.com/repos/owner/project/installation",
  ]);
});

test("pull_request mode rejects tags and commits that are not branches", async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  await assert.rejects(
    resolveRepositoryAccess(
      {
        GITHUB_APP_ID: "4385224",
        GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
      },
      { githubAccessToken: "token" },
      { repo: "owner/project", mode: "pull_request", ref: "deadbeef" },
    ),
    /requires ref to name an accessible branch/,
  );
});

test("edit mode does not require a branch-only ref", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
    }
    return Response.json({ permissions: { contents: "write" } });
  };

  await resolveRepositoryAccess(
    {
      GITHUB_APP_ID: "4385224",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
    },
    { githubAccessToken: "token" },
    { repo: "owner/project", mode: "edit", ref: "deadbeef" },
  );

  assert.deepEqual(requests, [
    "https://api.github.com/repos/owner/project",
    "https://api.github.com/repos/owner/project/installation",
  ]);
});

test("workflow dispatch resolves the App installation from the runner repository", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/repos/Harness-X-Harness/runner/installation")) {
      return Response.json({ id: 987654 });
    }
    if (String(url).endsWith("/app/installations/987654/access_tokens")) {
      return Response.json({ token: "installation-token" });
    }
    if (String(url).endsWith("/actions/workflows/execute-task.yml/dispatches")) {
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected request", { status: 500 });
  };

  await dispatchWorkflow(
    {
      GITHUB_APP_ID: "4385224",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
      GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
      GITHUB_WORKFLOW_ID: "execute-task.yml",
      GITHUB_RUNNER_REF: "main",
    },
    {
      id: "task-123",
      repo: "Harness-X-Harness/target",
      ref: "main",
      executor: "codex",
      mode: "analyze",
      repositoryAccess: "public_read",
    },
  );

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://api.github.com/repos/Harness-X-Harness/runner/installation",
      "https://api.github.com/app/installations/987654/access_tokens",
      "https://api.github.com/repos/Harness-X-Harness/runner/actions/workflows/execute-task.yml/dispatches",
    ],
  );
  assert.match(requests[0].init.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    repositories: ["runner"],
    permissions: { actions: "write" },
  });
  assert.equal(requests[2].init.headers.authorization, "Bearer installation-token");
  assert.equal(
    JSON.parse(requests[2].init.body).inputs.repository_access,
    "public_read",
  );
});

test("Environment dispatch returns the exact GitHub workflow run identity", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/repos/Harness-X-Harness/runner/installation")) {
      return Response.json({ id: 987654 });
    }
    if (String(url).endsWith("/app/installations/987654/access_tokens")) {
      return Response.json({ token: "installation-token" });
    }
    if (String(url).endsWith("/actions/workflows/private-runner-session.yml/dispatches")) {
      return Response.json({
        workflow_run_id: 24680,
        run_url: "https://api.github.com/repos/Harness-X-Harness/runner/actions/runs/24680",
        html_url: "https://github.com/Harness-X-Harness/runner/actions/runs/24680",
      });
    }
    return new Response("unexpected request", { status: 500 });
  };

  const run = await dispatchEnvironmentWorkflow(
    {
      GITHUB_APP_ID: "4385224",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
      GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
      GITHUB_ENVIRONMENT_WORKFLOW_ID: "private-runner-session.yml",
      GITHUB_RUNNER_REF: "main",
    },
    {
      environmentId: "environment-generation",
      environmentOwner: "owner-slot",
    },
  );

  assert.deepEqual(run, {
    runId: "24680",
    runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/24680",
  });
  const dispatch = requests.at(-1);
  assert.equal(dispatch.init.headers["x-github-api-version"], "2026-03-10");
  assert.deepEqual(JSON.parse(dispatch.init.body), {
    ref: "main",
    inputs: {
      environment_id: "environment-generation",
      environment_owner: "owner-slot",
    },
  });
});

test("Environment dispatch distinguishes rejection from an unknown effect", async () => {
  const cases = [
    { status: 422, body: { message: "invalid" }, outcome: "rejected" },
    { status: 503, body: { message: "unavailable" }, outcome: "unknown" },
    { status: 200, body: {}, outcome: "unknown" },
  ];
  for (const expected of cases) {
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/repos/Harness-X-Harness/runner/installation")) {
        return Response.json({ id: 987654 });
      }
      if (String(url).endsWith("/app/installations/987654/access_tokens")) {
        return Response.json({ token: "installation-token" });
      }
      return Response.json(expected.body, { status: expected.status });
    };
    await assert.rejects(
      dispatchEnvironmentWorkflow(
        {
          GITHUB_APP_ID: "4385224",
          GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
          GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
          GITHUB_ENVIRONMENT_WORKFLOW_ID: "private-runner-session.yml",
          GITHUB_RUNNER_REF: "main",
        },
        {
          environmentId: "environment-generation",
          environmentOwner: "owner-slot",
        },
        fetchImpl,
      ),
      (error) => error instanceof EnvironmentDispatchError &&
        error.outcome === expected.outcome,
    );
  }
});

test("Environment terminal readback observes one exact GitHub workflow run", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/repos/Harness-X-Harness/runner/installation")) {
      return Response.json({ id: 987654 });
    }
    if (String(url).endsWith("/app/installations/987654/access_tokens")) {
      return Response.json({ token: "installation-token" });
    }
    if (String(url).endsWith("/actions/runs/24680")) {
      return Response.json({ status: "completed", conclusion: "cancelled" });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const run = await getEnvironmentWorkflowRun({
    GITHUB_APP_ID: "4385224",
    GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
    GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
  }, "24680");
  assert.deepEqual(run, { status: "completed", conclusion: "cancelled" });
  assert.match(requests.at(-1).url, /\/actions\/runs\/24680$/);
});

test("Environment readback reuses one unexpired installation token", async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/repos/Harness-X-Harness/cache-runner/installation")) {
      return Response.json({ id: 777 });
    }
    if (String(url).endsWith("/app/installations/777/access_tokens")) {
      return Response.json({
        token: "cached-installation-token",
        expires_at: "2999-01-01T00:00:00Z",
      });
    }
    if (String(url).includes("/actions/runs/")) {
      return Response.json({ status: "in_progress", conclusion: null });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const env = {
    GITHUB_APP_ID: "cache-test-app",
    GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem(),
    GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/cache-runner",
  };
  await getEnvironmentWorkflowRun(env, "100");
  await getEnvironmentWorkflowRun(env, "100");
  assert.equal(requests.filter(({ url }) => url.endsWith("/installation")).length, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith("/access_tokens")).length, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith("/actions/runs/100")).length, 2);
});

test("workflow selects exactly one target checkout authorization path", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/execute-task.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /repository_access:\n\s+description: Verified target repository access path/);
  assert.match(workflow, /name: Create target repository token\n\s+if: \$\{\{ inputs\.repository_access == 'installation' \}\}/);
  assert.match(workflow, /name: Check out installed target repository[\s\S]*token: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(workflow, /name: Check out public target repository[\s\S]*inputs\.repository_access == 'public_read'/);
  assert.match(workflow, /inputs\.repository_access == 'public_read' && inputs\.mode != 'analyze'/);
  assert.doesNotMatch(workflow, /continue-on-error:/);
});

test("workflow returns the driver result and skips delivery when no files changed", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/execute-task.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /- name: Detect task changes\n\s+id: changes/);
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.mode != 'analyze' && steps\.changes\.outputs\.changed == 'true' \}\}/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.mode == 'pull_request' && steps\.changes\.outputs\.changed == 'true' \}\}/,
  );
  assert.match(workflow, /summary="\$\(< "\$RUNNER_TEMP\/executor\.result"\)"/);
  assert.doesNotMatch(workflow, /summary="No changes produced\."/);
});

test("Codex executor uses the native CLI driver", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/execute-task.yml", import.meta.url),
    "utf8",
  );
  const driver = await readFile(
    new URL("../.github/actions/task-driver/index.js", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(workflow, /sudo sysctl -w kernel\.unprivileged_userns_clone=1/);
  assert.match(workflow, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.ok(
    workflow.indexOf("kernel.apparmor_restrict_unprivileged_userns=0") <
      workflow.indexOf("uses: ./.github/actions/task-driver"),
  );
  assert.match(workflow, /secrets\.MINI_CODEX_BASE_URL/);
  assert.match(workflow, /env_key = "MINI_END_USER_KEY"/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/task-driver/);
  assert.match(driver, /"--json"/);
  assert.match(driver, /"--output-last-message", resultFile/);
  assert.doesNotMatch(
    workflow,
    /openai\/codex-action|allow-bots:|allow-bot-users:|OPENAI_API_KEY|CODEX_API_KEY|CODEX_RESPONSES_API_ENDPOINT/,
  );
});

test("Grok executor writes its native headless result to the driver result", async () => {
  const driver = await readFile(
    new URL("../.github/actions/task-driver/index.js", import.meta.url),
    "utf8",
  );

  assert.match(driver, /"--output-format", "streaming-json"/);
  assert.match(driver, /result = updateGrokResult\(result, value\)/);
  assert.doesNotMatch(driver, /console\.log/);
});

test("Task Widget stream supports browser authorization preflight", async () => {
  const worker = await readFile(
    new URL("../apps/chatgpt-app/src/index.js", import.meta.url),
    "utf8",
  );

  assert.match(worker, /request\.method === "OPTIONS"/);
  assert.match(worker, /"access-control-allow-headers": "authorization"/);
  assert.match(worker, /"access-control-allow-methods": "GET, OPTIONS"/);
  assert.match(worker, /"access-control-allow-origin": "\*"/);
});

test("runner GitHub App credentials avoid GitHub's reserved secret prefix", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/execute-task.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /secrets\.RUNNER_GITHUB_APP_ID/);
  assert.match(workflow, /secrets\.RUNNER_GITHUB_APP_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_APP_/);
});

test("Cloudflare credential template documents the deployment permission boundary", async () => {
  const template = await readFile(
    new URL("../.secrets.env.example", import.meta.url),
    "utf8",
  );

  assert.match(template, /^CLOUDFLARE_API_TOKEN=$/m);
  assert.match(template, /^CLOUDFLARE_ACCOUNT_ID=$/m);
  assert.match(template, /Workers Scripts: Edit/);
  assert.match(template, /Workers KV Storage: Edit/);
  assert.match(template, /Account Settings: Read/);
  assert.doesNotMatch(template, /cf[a-z]+_[A-Za-z0-9_-]+/);

  const assignments = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
    ([, name]) => name,
  );
  assert.deepEqual(assignments, [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ]);
});

test("CI type-checks the Worker JavaScript source", async () => {
  const [configuration, workflow] = await Promise.all([
    readFile(new URL("../apps/chatgpt-app/tsconfig.json", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(configuration).compilerOptions.checkJs, true);
  assert.match(workflow, /npm ci --prefix apps\/chatgpt-app/);
  assert.match(workflow, /npm --prefix apps\/chatgpt-app run typecheck/);
});

test("submit_task records a failed state when workflow dispatch fails", async () => {
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/mcp.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /await dispatchWorkflow\(env, task\);/);
  assert.match(source, /status: "failed",\n\s+error: "workflow dispatch failed"/);
});

test("OAuth authorization routes use the dedicated authorization module", async () => {
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/index.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /authorizePage\(request, env\)/);
  assert.match(source, /submitAuthorizationDecision\(request, env\)/);
  assert.match(source, /completeAuthorizationCallback\(request, env\)/);
  assert.doesNotMatch(source, /parseAuthRequest|oauth:consent|github:oauth/);
});

test("application authorization state uses a strongly consistent Durable Object", async () => {
  const [authorization, githubState, installation, configuration] = await Promise.all([
    readFile(new URL("../apps/chatgpt-app/src/authorization.js", import.meta.url), "utf8"),
    readFile(new URL("../apps/chatgpt-app/src/github-oauth-state.js", import.meta.url), "utf8"),
    readFile(new URL("../apps/chatgpt-app/src/repository-authorization.js", import.meta.url), "utf8"),
    readFile(new URL("../apps/chatgpt-app/wrangler.jsonc", import.meta.url), "utf8"),
  ]);

  for (const source of [authorization, githubState, installation]) {
    assert.doesNotMatch(source, /OAUTH_KV/);
  }
  assert.match(configuration, /"name": "AUTHORIZATION_STATES"/);
  assert.match(configuration, /"new_sqlite_classes": \["AuthorizationStateObject"\]/);
});

test("OAuth protected-resource metadata requests the complete App capability set", async () => {
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/index.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /scopes_supported: \[\.\.\.OAUTH_SCOPES\]/);
  assert.doesNotMatch(source, /BASELINE_OAUTH_SCOPES/);
});

function testPrivateKeyPem() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  }).privateKey;
}
