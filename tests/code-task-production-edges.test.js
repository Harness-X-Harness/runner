import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import {
  dispatchWorkflow,
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

  assert.match(workflow, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.match(workflow, /secrets\.MINI_CODEX_BASE_URL/);
  assert.match(workflow, /env_key = "MINI_END_USER_KEY"/);
  assert.match(workflow, /working-directory: target-workspace/);
  assert.match(
    workflow,
    /codex exec --ephemeral --sandbox workspace-write --output-last-message "\$RUNNER_TEMP\/executor\.result"/,
  );
  assert.doesNotMatch(
    workflow,
    /openai\/codex-action|allow-bots:|allow-bot-users:|OPENAI_API_KEY|CODEX_API_KEY|CODEX_RESPONSES_API_ENDPOINT/,
  );
});

test("Grok executor writes its native headless result to the driver result", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/execute-task.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /grok --no-auto-update --always-approve -m mini-grok-4-6 --output-format plain --prompt-file "\$RUNNER_TEMP\/task\.prompt" > "\$RUNNER_TEMP\/executor\.result"/,
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
