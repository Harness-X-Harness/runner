export const ENVIRONMENT_CHANNEL_PROTOCOL = "harness.environment.v1";

export function connectEnvironmentChannel(current, connection) {
  if (!current || !new Set(["starting", "ready"]).has(current.status)) return undefined;
  if (
    current.generation !== String(connection.generation) ||
    current.runId !== String(connection.runId) ||
    (current.runAttempt !== undefined && current.runAttempt !== String(connection.runAttempt))
  ) return undefined;
  if (current.status === "ready" && !sameDescriptor(current, connection.descriptor)) return undefined;
  return {
    ...current,
    ...connection.descriptor,
    runAttempt: String(connection.runAttempt),
    status: "ready",
    channelState: "connected",
    connectionId: String(connection.connectionId),
    updatedAt: (connection.now?.() ?? new Date()).toISOString(),
  };
}

export function disconnectEnvironmentChannel(current, attachment, now = () => new Date()) {
  if (
    !current ||
    current.status !== "ready" ||
    current.channelState !== "connected" ||
    current.generation !== attachment?.generation ||
    current.runId !== attachment?.runId ||
    current.runAttempt !== attachment?.runAttempt ||
    current.connectionId !== attachment?.connectionId
  ) return current;
  return {
    ...current,
    channelState: "disconnected",
    connectionId: undefined,
    updatedAt: now().toISOString(),
  };
}

export function parseEnvironmentChannelMessage(message, attachment) {
  if (typeof message !== "string") return undefined;
  let value;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.generation !== attachment?.generation || !validId(value.sessionId)) return undefined;
  if (value.type === "ack") {
    if (!exactKeys(value, ["type", "generation", "sessionId", "commandId"]) ||
        !validId(value.commandId)) return undefined;
    return value;
  }
  if (value.type === "event") {
    if (!exactKeys(value, ["type", "generation", "sessionId", "event"]) ||
        !value.event || typeof value.event !== "object" || Array.isArray(value.event)) return undefined;
    return value;
  }
  return undefined;
}

export function channelAllowsSessionAction(environment, action) {
  return action?.type !== "accept_command" || action.kind !== "steer" ||
    environment?.channelState === "connected";
}

function sameDescriptor(current, descriptor) {
  return descriptor &&
    current.pairingUrl === descriptor.pairingUrl &&
    current.t3Url === descriptor.t3Url &&
    current.tailscaleHost === descriptor.tailscaleHost;
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
