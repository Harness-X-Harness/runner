import {
  exchangeGitHubUserCode,
  requestGitHubUserProfile,
} from "./github-user-auth.js";
import { startGitHubAuthorization } from "./github-oauth-state.js";
import {
  deleteAuthorizationState,
  getAuthorizationState,
  putAuthorizationState,
} from "./authorization-state.js";
import { dispatchWorkflow, githubHeaders, signAppJwt } from "./github.js";
import {
  claimTaskDispatch,
  commitTaskDispatch,
  readTask,
  updateTask,
} from "./task-store.js";

const API = "https://api.github.com";
const INSTALL_STATE_TTL = 604800;
const DEFAULT_APP_SLUG = "harness-x-harness-task-runner";

export async function resolveRepositoryAccess(
  env,
  props,
  task,
  fetchImpl = fetch,
) {
  const token = props?.githubAccessToken;
  if (!token) throw new Error("GitHub authorization is required");

  const repositoryResponse = await fetchImpl(`${API}/repos/${task.repo}`, {
    headers: githubHeaders(token),
  });
  const requiredPermissions = permissionsForMode(task.mode);

  if (repositoryResponse.status === 404) {
    return { kind: "installation_required", requiredPermissions };
  }
  if (!repositoryResponse.ok) {
    throw new Error(
      `GitHub repository lookup failed with ${repositoryResponse.status}`,
    );
  }

  const repository = await repositoryResponse.json();
  if (task.mode !== "analyze" && !repository.permissions?.push) {
    throw new Error("GitHub write access is required for this task mode");
  }
  if (task.mode === "pull_request") {
    const branchResponse = await fetchImpl(
      `${API}/repos/${task.repo}/branches/${encodeURIComponent(task.ref)}`,
      { headers: githubHeaders(token) },
    );
    if (!branchResponse.ok) {
      throw new Error(
        "pull_request mode requires ref to name an accessible branch",
      );
    }
  }

  if (task.mode === "analyze" && repository.private === false) {
    return { kind: "ready", repositoryAccess: "public_read" };
  }

  const installation = await repositoryInstallation(env, task.repo, fetchImpl);
  if (
    installation.kind === "missing" ||
    !installationHasPermissions(installation.value, requiredPermissions)
  ) {
    return { kind: "installation_required", requiredPermissions };
  }

  return { kind: "ready", repositoryAccess: "installation" };
}

export async function createInstallationRequest(env, task) {
  const state = `repo_install_${crypto.randomUUID()}`;
  await putAuthorizationState(
    env,
    `github:install:${state}`,
    { taskId: task.id, ownerId: task.ownerId },
    INSTALL_STATE_TTL,
  );
  const url = new URL("/github/install", env.TASK_CONTROL_PLANE_URL);
  url.searchParams.set("state", state);
  return { authorizationUrl: url.toString() };
}

export async function startInstallationAuthorization(
  request,
  env,
  fetchImpl = fetch,
) {
  const url = new URL(request.url);
  const state =
    url.searchParams.get("state") ??
    cookieValue(request.headers.get("cookie"), "__Host-RUNNER_INSTALL_STATE");
  if (!state) return text("Missing repository authorization state", 400);

  const authorization = await getAuthorizationState(
    env,
    `github:install:${state}`,
  );
  if (!authorization) return text("Expired repository authorization state", 400);
  const task = await readTask(env, authorization.taskId);
  if (
    task.status !== "awaiting_installation" ||
    task.ownerId !== authorization.ownerId
  ) {
    return text("This task no longer requires repository authorization", 409);
  }

  const installation = await repositoryInstallation(env, task.repo, fetchImpl);
  const cookie = installStateCookie(state);
  if (installation.kind === "missing") {
    const github = new URL(
      `https://github.com/apps/${env.GITHUB_APP_SLUG ?? DEFAULT_APP_SLUG}/installations/new`,
    );
    github.searchParams.set("state", state);
    return redirect(github, cookie);
  }
  if (
    !installationHasPermissions(
      installation.value,
      task.requiredPermissions ?? permissionsForMode(task.mode),
    )
  ) {
    return redirect(installation.value.html_url, cookie);
  }

  const callback = `${url.origin}/github/callback`;
  const response = await startGitHubAuthorization(
    env,
    callback,
    {
      kind: "installation",
      taskId: task.id,
      ownerId: task.ownerId,
      installState: state,
    },
    "install_oauth_",
  );
  response.headers.append("set-cookie", cookie);
  return response;
}

export async function completeInstallationAuthorization(
  env,
  authorization,
  fetchImpl = fetch,
) {
  const installation = authorization.payload;

  let token;
  let profile;
  try {
    token = await exchangeGitHubUserCode(
      env,
      authorization.code,
      authorization.callback,
      authorization.codeVerifier,
      fetchImpl,
    );
    profile = await requestGitHubUserProfile(token.access_token, fetchImpl);
  } catch {
    return text("GitHub authorization verification failed", 502);
  }
  if (String(profile.id) !== String(installation.ownerId)) {
    return text("Authorize with the GitHub user who submitted this task", 403);
  }

  const task = await readTask(env, installation.taskId);
  if (task.ownerId !== String(profile.id)) return text("Task not found", 404);
  if (task.status !== "awaiting_installation") {
    return text(`Task is already ${task.status}.`);
  }

  const access = await resolveRepositoryAccess(
    env,
    { githubAccessToken: token.access_token },
    task,
    fetchImpl,
  );
  if (access.kind !== "ready" || access.repositoryAccess !== "installation") {
    return text("Repository authorization is still required", 409);
  }

  const claim = await claimTaskDispatch(
    env,
    task.id,
    access.repositoryAccess,
  );
  if (!claim.claimed) return text(`Task is already ${claim.task.status}.`);

  try {
    await dispatchWorkflow(env, claim.task, fetchImpl);
    const queued = await commitTaskDispatch(env, task.id);
    await deleteAuthorizationState(
      env,
      `github:install:${installation.installState}`,
    );
    return text(`Repository authorized. Task ${queued.id} is ${queued.status}.`);
  } catch {
    await updateTask(env, task.id, {
      status: "failed",
      error: "workflow dispatch failed",
    });
    return text("Repository was authorized, but workflow dispatch failed", 502);
  }
}

async function repositoryInstallation(env, repo, fetchImpl) {
  const appJwt = await signAppJwt(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
  );
  const response = await fetchImpl(`${API}/repos/${repo}/installation`, {
    headers: githubHeaders(appJwt),
  });
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) {
    throw new Error(
      `GitHub App installation lookup failed with ${response.status}`,
    );
  }
  return { kind: "installed", value: await response.json() };
}

function permissionsForMode(mode) {
  if (mode === "analyze") return ["contents:read"];
  if (mode === "edit") return ["contents:write"];
  return ["contents:write", "pull_requests:write"];
}

function installationHasPermissions(installation, required) {
  const permissions = installation?.permissions ?? {};
  return required.every((requirement) => {
    const [name, level] = requirement.split(":");
    const actual = permissions[name];
    if (level === "read") return ["read", "write", "admin"].includes(actual);
    return ["write", "admin"].includes(actual);
  });
}

function redirect(location, cookie) {
  return new Response(null, {
    status: 302,
    headers: {
      location: String(location),
      "set-cookie": cookie,
    },
  });
}

function installStateCookie(state) {
  return `__Host-RUNNER_INSTALL_STATE=${state}; HttpOnly; Secure; Path=/github; SameSite=Lax; Max-Age=${INSTALL_STATE_TTL}`;
}

function cookieValue(header, name) {
  return (header ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
