// Temporary release boundary. Remove with the retained legacy product, not its data early.
export const isLegacyDrain = (env) => env.LEGACY_DRAIN_MODE === "true";
export const LEGACY_DRAIN_TOOLS = new Set(["list_sessions", "read_session", "close_environment"]);
export const LEGACY_RETIRED = "Legacy execution is retired. Use run_task with tasks:manage. Retained sessions can still be read and environments closed.";

export function legacyStoreRequestAllowed(request) {
  const path = new URL(request.url).pathname;
  if (request.method === "GET") return path === "/environment" || /^\/sessions(?:\/[^/]+)?$/.test(path);
  // Preserve exact late dispatch ownership and terminal/close reconciliation, not admission.
  return request.method === "POST" && ["/environment/dispatch", "/environment/close",
    "/environment/cancel", "/environment/terminal"].includes(path);
}

export function retainedSession(env, session) {
  return isLegacyDrain(env) ? { ...session, allowedActions: [], allowedTurnDeliveries: [] } : session;
}
