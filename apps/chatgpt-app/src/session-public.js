const ACTIVE_ENVIRONMENT_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);

export function publicSessionSnapshot(
  session,
  environment,
  grantId,
  controlPlaneUrl,
) {
  const matchingEnvironment = environment?.generation === session.generation
    ? environment
    : undefined;
  const pendingReplacement = environment?.status === "closing" &&
    environment.replacementGeneration === session.generation;
  const currentGrant = session.controllerGrantId === grantId;
  const actionProjection = sessionAllowedActions(session, matchingEnvironment, currentGrant);
  return {
    sessionId: session.sessionId,
    executor: session.executor,
    phase: session.phase,
    ...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
    channelState: matchingEnvironment?.channelState === "connected" ? "connected" : "disconnected",
    controller: {
      clientName: session.controllerClientName,
      currentGrant,
    },
    allowedActions: actionProjection.actions,
    allowedTurnDeliveries: actionProjection.turnDeliveries,
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

function sessionAllowedActions(session, environment, currentGrant) {
  if (["stopping", "terminal"].includes(session.phase)) {
    return { actions: [], turnDeliveries: [] };
  }
  if (!currentGrant) {
    return { actions: ["take_over_session"], turnDeliveries: [] };
  }

  const actions = [];
  const turnDeliveries = [];
  if (environment?.channelState === "connected" && ["idle", "running"].includes(session.phase)) {
    turnDeliveries.push("steer");
  }
  if (["idle", "running", "waiting_for_user"].includes(session.phase)) {
    turnDeliveries.push("queue");
  }
  if (turnDeliveries.length > 0) actions.push("send_turn");
  if (session.phase === "running" && session.activeTurnId) actions.push("interrupt_turn");
  if (session.pendingRequests.length > 0) actions.push("respond_to_session");
  if (session.queuedTurns.length > 0) actions.push("cancel_queued_turn");
  actions.push("stop_session");
  return { actions, turnDeliveries };
}

function publicEnvironmentStatus(environment) {
  if (!environment || !ACTIVE_ENVIRONMENT_STATUSES.has(environment.status)) return "offline";
  if (environment.status === "ready") return "ready";
  if (environment.status === "closing") return "closing";
  return "starting";
}
