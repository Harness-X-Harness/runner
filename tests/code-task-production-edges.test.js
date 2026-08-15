import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import {
  authorizeRepository,
  dispatchWorkflow,
} from "../apps/chatgpt-app/src/github.js";

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
    return new Response(JSON.stringify({ name: "feature/task" }), { status: 200 });
  };

  await authorizeRepository(
    "owner/project",
    { githubAccessToken: "token" },
    "pull_request",
    "feature/task",
  );

  assert.deepEqual(requests, [
    "https://api.github.com/repos/owner/project",
    "https://api.github.com/repos/owner/project/branches/feature%2Ftask",
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
    authorizeRepository(
      "owner/project",
      { githubAccessToken: "token" },
      "pull_request",
      "deadbeef",
    ),
    /requires ref to name an accessible branch/,
  );
});

test("edit mode does not require a branch-only ref", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
  };

  await authorizeRepository(
    "owner/project",
    { githubAccessToken: "token" },
    "edit",
    "deadbeef",
  );

  assert.deepEqual(requests, ["https://api.github.com/repos/owner/project"]);
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
});

test("workflow skips delivery steps when an executor produces no changes", async () => {
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
  assert.match(workflow, /summary="No changes produced\."/);
});

test("Codex executor uses the pinned Codex Action with forwarding credentials", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/execute-task.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /uses: openai\/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56/,
  );
  assert.match(
    workflow,
    /openai-api-key: \$\{\{ secrets\.MINI_END_USER_KEY \}\}/,
  );
  assert.match(
    workflow,
    /responses-api-endpoint: \$\{\{ secrets\.MINI_CODEX_BASE_URL \}\}\/responses/,
  );
  assert.match(workflow, /model: gpt-5\.6-sol/);
  assert.match(workflow, /prompt-file: \$\{\{ runner\.temp \}\}\/task\.prompt/);
  assert.match(workflow, /working-directory: target-workspace/);
  assert.match(workflow, /permission-profile: ":workspace"/);
  assert.match(
    workflow,
    /allow-bot-users: "harness-x-harness-task-runner\[bot\]"/,
  );
  assert.doesNotMatch(workflow, /allow-bots:/);
  assert.doesNotMatch(
    workflow,
    /OPENAI_API_KEY|CODEX_API_KEY|CODEX_RESPONSES_API_ENDPOINT|chatgpt\.com\/codex\/install\.sh/,
  );
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

test("invalid OAuth authorization requests return a safe client error", async () => {
  const source = await readFile(
    new URL("../apps/chatgpt-app/src/index.js", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /try \{\n\s+authRequest = await env\.OAUTH_PROVIDER\.parseAuthRequest\(request\);\n\s+\} catch \{\n\s+return new Response\("Invalid OAuth authorization request", \{ status: 400 \}\);/,
  );
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
