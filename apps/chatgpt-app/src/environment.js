import {
  EnvironmentDispatchError,
} from "./github.js";
import { issueEnvironmentIdentity } from "./environment-identity.js";

const ACTIVE_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);

export async function openEnvironment(
  env,
  ownerId,
  dispatch,
  newGeneration = () => issueEnvironmentIdentity(ownerId, env.ENVIRONMENT_SESSION_SECRET),
  cancel = missingWorkflowAuthority,
  observe = missingWorkflowAuthority,
) {
  if (typeof dispatch !== "function") throw new TypeError("Environment dispatch authority is required");
  let current = await readEnvironment(env, ownerId);
  if (current?.runId && ACTIVE_STATUSES.has(current.status)) {
    try {
      current = await reconcileEnvironment(env, ownerId, current, observe);
    } catch {
      return publicEnvironment(current, env.TASK_CONTROL_PLANE_URL);
    }
  }
  if (current && ACTIVE_STATUSES.has(current.status)) {
    return publicEnvironment(current, env.TASK_CONTROL_PLANE_URL);
  }
  const generation = await newGeneration();
  const claim = await environmentRequest(env, ownerId, "/environment/open", {
    method: "POST",
    body: JSON.stringify({ ownerId: String(ownerId), generation }),
  });

  let environment = claim.environment;
  if (claim.dispatch) {
    environment = await dispatchClaimedEnvironment(
      env,
      ownerId,
      environment,
      dispatch,
      cancel,
      true,
    );
  }
  return publicEnvironment(environment, env.TASK_CONTROL_PLANE_URL);
}

export async function dispatchClaimedEnvironment(
  env,
  ownerId,
  environment,
  dispatch,
  cancel = missingWorkflowAuthority,
  throwRejected = false,
) {
  const generation = environment.generation;
  let run;
  try {
    run = await dispatch(env, {
      environmentId: generation,
      environmentOwner: environment.slot,
    });
  } catch (error) {
    if (error instanceof EnvironmentDispatchError && error.outcome === "rejected") {
      const failed = await environmentRequest(env, ownerId, "/environment/dispatch-failed", {
        method: "POST",
        body: JSON.stringify({ generation }),
      });
      if (throwRejected) throw error;
      return failed;
    }
    return environmentRequest(
      env,
      ownerId,
      "/environment/dispatch-unknown",
      {
        method: "POST",
        body: JSON.stringify({ generation }),
      },
    );
  }
  const committed = await environmentRequest(
    env,
    ownerId,
    "/environment/dispatch",
    {
      method: "POST",
      body: JSON.stringify({ generation, ...run }),
    },
  );
  if (!committed.cancel) return committed.environment;
  return cancelRecordedEnvironment(
    env,
    ownerId,
    committed.environment,
    cancel,
  );
}

export async function closeEnvironment(
  env,
  ownerId,
  cancel = missingWorkflowAuthority,
) {
  const closing = await environmentRequest(env, ownerId, "/environment/close", {
    method: "POST",
  });
  if (!closing) return { status: "offline" };
  let environment = closing.environment;
  if (environment.runId && closing.cancel) {
    environment = await cancelRecordedEnvironment(
      env,
      ownerId,
      environment,
      cancel,
    );
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
  observe = missingWorkflowAuthority,
) {
  const run = await observe(env, environment.runId);
  if (run.status !== "completed") return environment;
  return environmentRequest(env, ownerId, "/environment/terminal", {
    method: "POST",
    body: JSON.stringify({ runId: environment.runId }),
  });
}

/** @returns {Promise<any>} */
async function missingWorkflowAuthority(_env, _value) {
  throw new Error("GitHub OAuth workflow authority is required");
}

async function cancelRecordedEnvironment(env, ownerId, environment, cancel) {
  try {
    await cancel(env, environment.runId);
  } catch {
    return environment;
  }
  return environmentRequest(env, ownerId, "/environment/cancel", {
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
