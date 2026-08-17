import {
  cancelEnvironmentWorkflow,
  dispatchEnvironmentWorkflow,
  getEnvironmentWorkflowRun,
} from "./github.js";
import { issueEnvironmentIdentity } from "./environment-identity.js";

const ACTIVE_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);

export async function openEnvironment(
  env,
  ownerId,
  dispatch = dispatchEnvironmentWorkflow,
  newGeneration = () => issueEnvironmentIdentity(ownerId, env.ENVIRONMENT_SESSION_SECRET),
  cancel = cancelEnvironmentWorkflow,
  observe = getEnvironmentWorkflowRun,
) {
  let current = await readEnvironment(env, ownerId);
  if (current && ACTIVE_STATUSES.has(current.status)) {
    if (current.runId) {
      current = await reconcileEnvironment(env, ownerId, current, observe);
    }
    if (ACTIVE_STATUSES.has(current.status)) {
      return publicEnvironment(current, env.TASK_CONTROL_PLANE_URL);
    }
  }
  const generation = await newGeneration();
  const claim = await environmentRequest(env, ownerId, "/environment/open", {
    method: "POST",
    body: JSON.stringify({ ownerId: String(ownerId), generation }),
  });

  let environment = claim.environment;
  if (claim.dispatch) {
    const run = await dispatch(env, { environmentId: generation });
    const committed = await environmentRequest(
      env,
      ownerId,
      "/environment/dispatch",
      {
        method: "POST",
        body: JSON.stringify({ generation, ...run }),
      },
    );
    environment = committed.environment;
    if (committed.cancel) await cancel(env, run.runId);
  }
  return publicEnvironment(environment, env.TASK_CONTROL_PLANE_URL);
}

export async function closeEnvironment(
  env,
  ownerId,
  cancel = cancelEnvironmentWorkflow,
  observe = getEnvironmentWorkflowRun,
) {
  const closing = await environmentRequest(env, ownerId, "/environment/close", {
    method: "POST",
  });
  if (!closing) return { status: "offline" };
  let environment = closing.environment;
  if (environment.runId) {
    const run = await observe(env, environment.runId);
    if (run.status === "completed") {
      environment = await environmentRequest(env, ownerId, "/environment/terminal", {
        method: "POST",
        body: JSON.stringify({ runId: environment.runId }),
      });
    } else if (closing.cancel) {
      await cancel(env, environment.runId);
    }
  }
  return publicEnvironment(environment, env.TASK_CONTROL_PLANE_URL);
}

export function publicEnvironment(environment, controlPlaneUrl) {
  if (!environment || !ACTIVE_STATUSES.has(environment.status)) {
    return { status: "offline" };
  }
  return {
    status: environment.status === "ready"
      ? "ready"
      : environment.status === "closing" ? "closing" : "starting",
    environmentUrl: new URL("/environment", controlPlaneUrl).toString(),
    ...(environment.runUrl ? { runUrl: environment.runUrl } : {}),
  };
}

export async function readEnvironment(env, ownerId) {
  return environmentRequest(env, ownerId, "/environment");
}

export async function reconcileEnvironment(
  env,
  ownerId,
  environment,
  observe = getEnvironmentWorkflowRun,
) {
  const run = await observe(env, environment.runId);
  if (run.status !== "completed") return environment;
  return environmentRequest(env, ownerId, "/environment/terminal", {
    method: "POST",
    body: JSON.stringify({ runId: environment.runId }),
  });
}

export async function environmentRequest(env, ownerId, path, init) {
  const stub = env.ENVIRONMENTS.get(
    env.ENVIRONMENTS.idFromName(`github-${ownerId}`),
  );
  const response = await stub.fetch(`https://environment${path}`, init);
  if (!response.ok) {
    if (response.status === 404) return undefined;
    throw new Error(`Environment store request failed with ${response.status}`);
  }
  return response.json();
}
