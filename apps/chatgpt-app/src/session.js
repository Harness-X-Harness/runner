import { dispatchClaimedEnvironment, readEnvironment } from "./environment.js";
import { issueEnvironmentIdentity } from "./environment-identity.js";

const ACTIVE_ENVIRONMENT_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);
const DEFAULT_WORKING_DIRECTORY = "/home/runner";

export async function startAgentSession(
  env,
  ownerId,
  controller,
  input,
  dispatch,
  cancel,
  newGeneration = () => issueEnvironmentIdentity(ownerId, env.ENVIRONMENT_SESSION_SECRET),
) {
  if (typeof dispatch !== "function") throw new TypeError("Environment dispatch authority is required");
  const sessionId = `session_${crypto.randomUUID()}`;
  const initialTurnId = input.initialPrompt ? `turn_${crypto.randomUUID()}` : undefined;
  const created = await sessionRequest(env, ownerId, "/environment/start-session", {
    method: "POST",
    body: JSON.stringify({
      ownerId,
      newGeneration: await newGeneration(),
      session: {
        sessionId,
        controllerGrantId: controller.grantId,
        controllerClientName: controller.clientName,
        executor: input.executor,
        workingDirectory: input.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
        startCommandId: `command_${crypto.randomUUID()}`,
        ...(initialTurnId
          ? { initialTurnId, initialPrompt: input.initialPrompt }
          : {}),
      },
    }),
  });
  let environment = created.environment;
  if (created.dispatch) {
    environment = await dispatchClaimedEnvironment(
      env,
      ownerId,
      environment,
      dispatch,
      cancel,
    );
  }
  const current = created.dispatch
    ? await sessionRecord(env, ownerId, sessionId)
    : created.session;
  return sessionSnapshot(current, environment, controller, env.TASK_CONTROL_PLANE_URL);
}

export async function listAgentSessions(env, ownerId, controller) {
  const [body, environment] = await Promise.all([
    sessionRequest(env, ownerId, "/sessions"),
    readEnvironment(env, ownerId),
  ]);
  return body.sessions.map((session) =>
    sessionSnapshot(session, environment, controller, env.TASK_CONTROL_PLANE_URL));
}

export async function readAgentSession(env, ownerId, controller, sessionId, options = {}) {
  const query = new URLSearchParams();
  if (options.afterCursor !== undefined) query.set("after", String(options.afterCursor));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const [body, environment] = await Promise.all([
    sessionRequest(env, ownerId, `/sessions/${encodeURIComponent(sessionId)}?${query}`),
    readEnvironment(env, ownerId),
  ]);
  return {
    session: sessionSnapshot(body.session, environment, controller, env.TASK_CONTROL_PLANE_URL),
    events: body.events,
    nextCursor: body.nextCursor,
    hasMore: body.hasMore,
  };
}

export async function sendAgentTurn(env, ownerId, controller, sessionId, text, delivery = "steer") {
  const current = await sessionRecord(env, ownerId, sessionId);
  const turnId = `turn_${crypto.randomUUID()}`;
  let action;
  if (delivery === "queue") {
    action = {
      type: "queue_turn",
      generation: current.generation,
      grantId: controller.grantId,
      turnId,
      text,
    };
  } else if (current.phase === "idle") {
    action = commandAction(current, controller, "start", { turnId, text });
  } else if (current.phase === "running") {
    action = commandAction(current, controller, "steer", {
      turnId: current.activeTurnId,
      text,
    });
  } else {
    throw new Error("Session cannot accept an immediate turn");
  }
  const updated = await mutateSession(env, ownerId, sessionId, action);
  return {
    turnId: action.turnId,
    delivery,
    session: await snapshotFromCurrentEnvironment(env, ownerId, controller, updated.session),
  };
}

export async function cancelAgentQueuedTurn(env, ownerId, controller, sessionId, turnId) {
  const current = await sessionRecord(env, ownerId, sessionId);
  const updated = await mutateSession(env, ownerId, sessionId, {
    type: "cancel_queued_turn",
    generation: current.generation,
    grantId: controller.grantId,
    turnId,
  });
  return snapshotFromCurrentEnvironment(env, ownerId, controller, updated.session);
}

export async function interruptAgentTurn(env, ownerId, controller, sessionId, activeTurnId) {
  const current = await sessionRecord(env, ownerId, sessionId);
  const updated = await mutateSession(
    env,
    ownerId,
    sessionId,
    commandAction(current, controller, "interrupt", { turnId: activeTurnId }),
  );
  return snapshotFromCurrentEnvironment(env, ownerId, controller, updated.session);
}

export async function respondToAgentSession(env, ownerId, controller, sessionId, response) {
  const current = await sessionRecord(env, ownerId, sessionId);
  const updated = await mutateSession(
    env,
    ownerId,
    sessionId,
    commandAction(current, controller, "response", {
      requestId: response.requestId,
      ...(response.choiceId ? { choiceId: response.choiceId } : {}),
      ...(response.values ? { answers: normalizeAnswers(response.values) } : {}),
    }),
  );
  return snapshotFromCurrentEnvironment(env, ownerId, controller, updated.session);
}

export async function takeOverAgentSession(env, ownerId, controller, sessionId) {
  const current = await sessionRecord(env, ownerId, sessionId);
  const updated = await mutateSession(env, ownerId, sessionId, {
    type: "take_over",
    generation: current.generation,
    grantId: controller.grantId,
    clientName: controller.clientName,
  });
  return snapshotFromCurrentEnvironment(env, ownerId, controller, updated.session);
}

export async function stopAgentSession(env, ownerId, controller, sessionId) {
  const current = await sessionRecord(env, ownerId, sessionId);
  if (current.phase === "terminal" || current.phase === "stopping") {
    return snapshotFromCurrentEnvironment(env, ownerId, controller, current);
  }
  const action = current.phase === "preparing"
    ? {
        type: "stop_before_admission",
        generation: current.generation,
        grantId: controller.grantId,
      }
    : commandAction(current, controller, "stop");
  const updated = await mutateSession(env, ownerId, sessionId, action);
  return snapshotFromCurrentEnvironment(env, ownerId, controller, updated.session);
}

function commandAction(session, controller, kind, fields = {}) {
  return {
    type: "accept_command",
    generation: session.generation,
    grantId: controller.grantId,
    commandId: `command_${crypto.randomUUID()}`,
    kind,
    ...fields,
  };
}

async function sessionRecord(env, ownerId, sessionId) {
  const body = await sessionRequest(
    env,
    ownerId,
    `/sessions/${encodeURIComponent(sessionId)}?after=${Number.MAX_SAFE_INTEGER}&limit=1`,
  );
  return body.session;
}

function mutateSession(env, ownerId, sessionId, action) {
  return sessionRequest(env, ownerId, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: JSON.stringify(action),
  });
}

async function snapshotFromCurrentEnvironment(env, ownerId, controller, session) {
  const environment = await readEnvironment(env, ownerId);
  return sessionSnapshot(session, environment, controller, env.TASK_CONTROL_PLANE_URL);
}

function sessionSnapshot(session, environment, controller, controlPlaneUrl) {
  const matchingEnvironment = environment?.generation === session.generation
    ? environment
    : undefined;
  const pendingReplacement = environment?.status === "closing" &&
    environment.replacementGeneration === session.generation;
  return {
    sessionId: session.sessionId,
    executor: session.executor,
    phase: session.phase,
    ...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
    channelState: matchingEnvironment?.channelState === "connected" ? "connected" : "disconnected",
    controller: {
      clientName: session.controllerClientName,
      currentGrant: session.controllerGrantId === controller.grantId,
    },
    workingDirectory: session.workingDirectory,
    ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
    queuedTurns: session.queuedTurns,
    pendingRequests: session.pendingRequests,
    latestCursor: session.latestCursor,
    environment: {
      status: pendingReplacement ? "closing" : publicEnvironmentStatus(matchingEnvironment),
      entryUrl: new URL("/environment", controlPlaneUrl).toString(),
      ...(matchingEnvironment?.runUrl ? { runUrl: matchingEnvironment.runUrl } : {}),
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function publicEnvironmentStatus(environment) {
  if (!environment || !ACTIVE_ENVIRONMENT_STATUSES.has(environment.status)) return "offline";
  if (environment.status === "ready") return "ready";
  if (environment.status === "closing") return "closing";
  return "starting";
}

function normalizeAnswers(values) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [
    name,
    Array.isArray(value) ? value : [value],
  ]));
}

async function sessionRequest(env, ownerId, path, init) {
  const stub = env.ENVIRONMENTS.get(
    env.ENVIRONMENTS.idFromName(`github-${ownerId}`),
  );
  const response = await stub.fetch(`https://environment${path}`, init);
  if (!response.ok) throw new Error(`Session store request failed with ${response.status}`);
  return response.json();
}
