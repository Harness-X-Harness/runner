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
  return {
    sessionId: session.sessionId,
    executor: session.executor,
    phase: session.phase,
    ...(session.terminalReason ? { terminalReason: session.terminalReason } : {}),
    channelState: matchingEnvironment?.channelState === "connected" ? "connected" : "disconnected",
    controller: {
      clientName: session.controllerClientName,
      currentGrant: session.controllerGrantId === grantId,
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
