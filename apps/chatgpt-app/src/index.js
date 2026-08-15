import {
  OAuthError,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

import {
  completeGitHubUserAuthorization,
  githubGrantTokenExchange,
  githubUserAuthorizationUrl,
  OAUTH_SCOPES,
} from "./github-user-auth.js";
import { handleMcpRequest } from "./mcp.js";
import { TaskObject } from "./task-object.js";

export { TaskObject };

export class McpApi extends WorkerEntrypoint {
  fetch(request) {
    return handleMcpRequest(request, this.env, this.ctx.props, this.ctx);
  }
}

export default {
  fetch(request, env, ctx) {
    return createOAuthProvider(env).fetch(request, env, ctx);
  },
};

function createOAuthProvider(env) {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: McpApi,
    defaultHandler: { fetch: defaultFetch },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: OAUTH_SCOPES,
    resourceMetadata: {
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "WeaverGroup code task runner",
    },
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: async (options) => {
      try {
        return await githubGrantTokenExchange(env, options);
      } catch {
        throw new OAuthError("invalid_grant", {
          description: "GitHub authorization expired or was revoked",
        });
      }
    },
  });
}

async function defaultFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  if (url.pathname.startsWith("/internal/tasks/")) {
    return internalTaskFetch(request, env, url);
  }

  if (url.pathname === "/authorize" && request.method === "GET") {
    return authorizePage(request, env);
  }

  if (url.pathname === "/authorize/consent" && request.method === "POST") {
    return startGithubAuthorization(request, env);
  }

  if (url.pathname === "/github/callback" && request.method === "GET") {
    return completeGitHubUserAuthorization(request, env);
  }

  return new Response("Not found", { status: 404 });
}

async function internalTaskFetch(request, env, url) {
  let claims;
  try {
    claims = await verifyRunnerIdentity(request, env);
  } catch {
    return json({ error: "runner authorization required" }, 401);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const taskId = parts[2];
  if (!taskId || (parts[3] !== undefined && parts[3] !== "events")) {
    return json({ error: "not found" }, 404);
  }
  const stub = env.TASKS.get(env.TASKS.idFromName(taskId));
  const taskResponse = await stub.fetch("https://task/task");
  if (!taskResponse.ok) return json({ error: "task not found" }, 404);
  const task = await taskResponse.json();
  if (task.runnerRepository !== undefined && task.runnerRepository !== env.GITHUB_RUNNER_REPOSITORY) {
    return json({ error: "task not found" }, 404);
  }
  const claimRunId = String(claims.run_id ?? "");
  if (task.runId !== undefined && String(task.runId) !== claimRunId) {
    return json({ error: "task not found" }, 404);
  }
  if (request.method === "GET" && parts[3] === undefined) {
    return json({
      taskId: task.id,
      repo: task.repo,
      ref: task.ref,
      executor: task.executor,
      mode: task.mode,
      status: task.status,
      prompt: task.prompt,
      runnerRepository: claims.repository,
    });
  }
  if (request.method === "POST" && parts[3] === "events") {
    const event = await request.json();
    if (event.runId !== undefined && String(event.runId) !== claimRunId) {
      return json({ error: "run identity does not match task" }, 403);
    }
    const updated = await stub.fetch("https://task/task", {
      method: "PATCH",
      body: JSON.stringify(event),
    });
    return new Response(await updated.text(), {
      status: updated.status,
      headers: { "content-type": "application/json" },
    });
  }
  return json({ error: "method not allowed" }, 405);
}

const githubOidcKeys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);

async function verifyRunnerIdentity(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("runner identity required");
  const { payload } = await jwtVerify(token, githubOidcKeys, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: env.TASK_CONTROL_PLANE_URL,
  });
  const configuredRef = env.GITHUB_RUNNER_REF ?? "main";
  const workflowRef = configuredRef.startsWith("refs/") ? configuredRef : `refs/heads/${configuredRef}`;
  const expectedWorkflow = `${env.GITHUB_RUNNER_REPOSITORY}/.github/workflows/${env.GITHUB_WORKFLOW_ID ?? "execute-task.yml"}@${workflowRef}`;
  if (payload.repository !== env.GITHUB_RUNNER_REPOSITORY || payload.workflow_ref !== expectedWorkflow || !payload.run_id) {
    throw new Error("runner identity is not trusted");
  }
  return payload;
}

async function authorizePage(request, env) {
  let authRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return new Response("Invalid OAuth authorization request", { status: 400 });
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return new Response("Unknown OAuth client", { status: 400 });

  const csrf = crypto.randomUUID();
  await env.OAUTH_KV.put(`oauth:consent:${csrf}`, JSON.stringify(authRequest), {
    expirationTtl: 600,
  });

  return html(
    "Authorize WeaverGroup runner",
    `<p><strong>${escapeHtml(client.clientName ?? "ChatGPT")}</strong> requests access to run code tasks.</p>
     <p>Requested scopes: ${escapeHtml(authRequest.scope.join(", ") || "none")}</p>
     <form method="post" action="/authorize/consent">
       <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
       <button type="submit">Continue with GitHub</button>
     </form>`,
    `__Host-RUNNER_CSRF=${csrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  );
}

async function startGithubAuthorization(request, env) {
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  const cookie = cookieValue(request.headers.get("cookie"), "__Host-RUNNER_CSRF");
  if (!csrf || csrf !== cookie) return new Response("Invalid consent state", { status: 400 });

  const authRequestJson = await env.OAUTH_KV.get(`oauth:consent:${csrf}`);
  if (!authRequestJson) return new Response("Expired consent state", { status: 400 });
  await env.OAUTH_KV.delete(`oauth:consent:${csrf}`);

  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`oauth:github:${state}`, authRequestJson, { expirationTtl: 600 });
  const callback = `${new URL(request.url).origin}/github/callback`;
  const github = githubUserAuthorizationUrl(env, callback, state);
  return Response.redirect(github, 302);
}

function html(title, body, setCookie) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
     <style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem}button{padding:.6rem 1rem}</style>
     <h1>${escapeHtml(title)}</h1>${body}`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com",
        "x-content-type-options": "nosniff",
        ...(setCookie ? { "set-cookie": setCookie } : {}),
      },
    },
  );
}

function cookieValue(header, name) {
  return (header ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
