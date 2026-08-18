const SESSION_META_PREFIX = "session:meta:";
const SESSION_EVENT_PREFIX = "session:event:";
const SESSION_TURN_PREFIX = "session:turn:";
const SESSION_COMMAND_PREFIX = "session:command:";

export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_PHASES = new Set([
  "preparing",
  "idle",
  "running",
  "waiting_for_user",
  "stopping",
  "terminal",
]);
const CONTROLLER_PHASES = new Set([
  "preparing",
  "idle",
  "running",
  "waiting_for_user",
]);
const MUTABLE_PHASES = new Set(["idle", "running", "waiting_for_user"]);
const TERMINAL_REASONS = new Set([
  "stopped",
  "environment_ended",
  "startup_failed",
  "driver_failed",
]);
const EVENT_FIELDS = {
  status: new Set(["phase", "channelState", "controllerGrantId", "terminalReason"]),
  user_message: new Set(["text", "turnId", "delivery"]),
  agent_message_chunk: new Set(["text", "turnId"]),
  activity: new Set(["label", "target", "command", "status", "error", "turnId"]),
  request: new Set(["requestId", "state", "kind", "title", "detail", "choices", "inputSchema"]),
  turn: new Set(["turnId", "status"]),
  error: new Set(["scope", "code", "message"]),
};

/**
 * Internal HTTP adapter for the Session aggregate owned by EnvironmentObject.
 * Authentication and Principal routing stay at the Worker boundary.
 */
export async function handleSessionRequest(storage, request, { now = () => new Date() } = {}) {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "sessions" || segments.length > 3) return json({ error: "not found" }, 404);

  if (request.method === "POST" && segments.length === 1) {
    const input = await readJson(request);
    if (!input) return json({ error: "invalid JSON" }, 400);
    return storage.transaction(async (transaction) => createSession(transaction, input, now));
  }

  if (request.method === "GET" && segments.length === 1) {
    const values = await listAll(storage, SESSION_META_PREFIX);
    const sessions = [...values.values()]
      .map(publicSession)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return json({ sessions });
  }

  const sessionId = segments[1];
  if (!sessionId || !validId(sessionId)) return json({ error: "session not found" }, 404);

  if (request.method === "GET" && segments[2] === "commands") {
    const session = await storage.get(metaKey(sessionId));
    if (!session) return json({ error: "session not found" }, 404);
    const values = await listAll(storage, commandPrefix(sessionId));
    const commands = [...values.values()]
      .filter(({ processed }) => !processed)
      .map(publicCommand)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return json({ commands });
  }

  if (segments.length !== 2) return json({ error: "not found" }, 404);

  if (request.method === "GET") {
    return readSession(storage, sessionId, url.searchParams);
  }

  if (request.method === "POST") {
    const action = await readJson(request);
    if (!action) return json({ error: "invalid JSON" }, 400);
    return storage.transaction(async (transaction) => applyAction(transaction, sessionId, action, now));
  }

  return json({ error: "not found" }, 404);
}

export async function terminateGenerationSessions(
  storage,
  generation,
  reason,
  { now = () => new Date() } = {},
) {
  if (!TERMINAL_REASONS.has(reason)) throw new TypeError("invalid Session terminal reason");
  const timestamp = now();
  const values = await listAll(storage, SESSION_META_PREFIX);
  let terminated = 0;
  let earliestExpiry;
  for (const [key, session] of values) {
    if (session.phase === "terminal") {
      earliestExpiry = minDate(earliestExpiry, session.expiresAt);
      continue;
    }
    if (session.generation !== String(generation)) continue;
    const next = terminalSession(session, reason, timestamp);
    await appendEvent(storage, next, {
      type: "status",
      data: { phase: "terminal", terminalReason: next.terminalReason },
    }, timestamp);
    await storage.put(key, next);
    earliestExpiry = minDate(earliestExpiry, next.expiresAt);
    terminated += 1;
  }
  if (earliestExpiry) await storage.setAlarm(new Date(earliestExpiry));
  return terminated;
}

export async function expireSessions(storage, { now = () => new Date() } = {}) {
  const timestamp = now();
  const values = await listAll(storage, SESSION_META_PREFIX);
  let expired = 0;
  let nextExpiry;
  for (const [key, session] of values) {
    if (session.phase !== "terminal" || !session.expiresAt) continue;
    if (new Date(session.expiresAt).getTime() > timestamp.getTime()) {
      nextExpiry = minDate(nextExpiry, session.expiresAt);
      continue;
    }
    await deleteSession(storage, key, session.sessionId);
    expired += 1;
  }
  if (nextExpiry) await storage.setAlarm(new Date(nextExpiry));
  else if (typeof storage.deleteAlarm === "function") await storage.deleteAlarm();
  return expired;
}

export async function pendingGenerationCommands(storage, generation) {
  const sessions = await listAll(storage, SESSION_META_PREFIX);
  const pending = [];
  for (const session of sessions.values()) {
    if (session.generation !== String(generation) || session.phase === "terminal") continue;
    const commands = await listAll(storage, commandPrefix(session.sessionId));
    for (const command of commands.values()) {
      if (!command.processed) pending.push({ sessionId: session.sessionId, ...publicCommand(command) });
    }
  }
  return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function createSession(storage, input, now) {
  const required = ["sessionId", "generation", "controllerGrantId", "executor", "workingDirectory"];
  if (required.some((field) => !validText(input[field]))) {
    return json({ error: "invalid session" }, 400);
  }
  if (!validId(input.sessionId) || !validId(input.generation) || !validId(input.controllerGrantId)) {
    return json({ error: "invalid session identity" }, 400);
  }
  if (!new Set(["codex", "grok"]).has(input.executor)) {
    return json({ error: "invalid executor" }, 400);
  }
  const key = metaKey(input.sessionId);
  if (await storage.get(key)) return json({ error: "session already exists" }, 409);
  const timestamp = now().toISOString();
  const session = {
    sessionId: input.sessionId,
    generation: input.generation,
    executor: input.executor,
    phase: "preparing",
    controllerGrantId: input.controllerGrantId,
    workingDirectory: input.workingDirectory,
    queuedTurns: [],
    activeTurnId: undefined,
    pendingRequests: [],
    processedCommandCount: 0,
    nextCursor: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await appendEvent(storage, session, { type: "status", data: { phase: "preparing" } }, now());
  await storage.put(key, session);
  return json({ session: publicSession(session) }, 201);
}

async function readSession(storage, sessionId, searchParams) {
  const session = await storage.get(metaKey(sessionId));
  if (!session) return json({ error: "session not found" }, 404);
  const after = parseNonNegativeInteger(searchParams.get("after"), 0);
  const limit = Math.min(parsePositiveInteger(searchParams.get("limit"), 100), 100);
  const values = await storage.list({
    prefix: eventPrefix(sessionId),
    startAfter: eventKey(sessionId, after),
    limit: limit + 1,
  });
  const remaining = [...values.values()];
  const events = remaining.slice(0, limit);
  return json({
    session: publicSession(session),
    events,
    nextCursor: events.at(-1)?.cursor ?? after,
    hasMore: remaining.length > events.length,
  });
}

async function applyAction(storage, sessionId, action, now) {
  const key = metaKey(sessionId);
  const session = await storage.get(key);
  if (!session) return json({ error: "session not found" }, 404);
  if (!validText(action.type)) return json({ error: "invalid session action" }, 400);
  if (String(action.generation) !== session.generation) {
    return json({ error: "environment generation mismatch" }, 409);
  }

  if (action.type === "terminate") return terminateOne(storage, key, session, action, now);
  if (session.phase === "terminal") return json({ error: "session is terminal" }, 409);

  switch (action.type) {
    case "admit":
      return admit(storage, key, session, now);
    case "take_over":
      return takeOver(storage, key, session, action, now);
    case "queue_turn":
      return queueTurn(storage, key, session, action, now);
    case "cancel_queued_turn":
      return cancelQueuedTurn(storage, key, session, action, now);
    case "accept_command":
      return acceptCommand(storage, key, session, action, now);
    case "process_command":
      return processCommand(storage, key, session, action, now);
    case "complete_turn":
      return completeTurn(storage, key, session, action, now);
    case "wait_for_user":
      return waitForUser(storage, key, session, action, now);
    case "append_event":
      return appendPublicEvent(storage, key, session, action, now);
    default:
      return json({ error: "unknown session action" }, 400);
  }
}

async function admit(storage, key, session, now) {
  if (session.phase !== "preparing") return json({ error: "session cannot be admitted" }, 409);
  const next = update(session, { phase: "idle" }, now());
  await appendEvent(storage, next, { type: "status", data: { phase: "idle" } }, now());
  await storage.put(key, next);
  return sessionResponse(next);
}

async function takeOver(storage, key, session, action, now) {
  if (!CONTROLLER_PHASES.has(session.phase) || !validId(action.grantId)) {
    return json({ error: "session cannot change controller" }, 409);
  }
  if (action.grantId === session.controllerGrantId) return sessionResponse(session, { duplicate: true });
  const next = update(session, { controllerGrantId: action.grantId }, now());
  await storage.put(key, next);
  return sessionResponse(next);
}

async function queueTurn(storage, key, session, action, now) {
  if (!controllerMatches(session, action) || !MUTABLE_PHASES.has(session.phase)) {
    return json({ error: "session controller or phase mismatch" }, 409);
  }
  if (!validId(action.turnId) || !validText(action.text)) return json({ error: "invalid turn" }, 400);
  if (await turnExists(storage, session.sessionId, action.turnId)) {
    return json({ error: "turn already exists" }, 409);
  }
  const timestamp = now();
  const turn = { turnId: action.turnId, text: action.text, createdAt: timestamp.toISOString() };
  const next = update(session, {
    queuedTurns: [...session.queuedTurns, { turnId: turn.turnId, createdAt: turn.createdAt }],
  }, timestamp);
  await storage.put({ [key]: next, [turnKey(session.sessionId, action.turnId)]: turn });
  return sessionResponse(next);
}

async function cancelQueuedTurn(storage, key, session, action, now) {
  if (!controllerMatches(session, action) || !MUTABLE_PHASES.has(session.phase)) {
    return json({ error: "session controller or phase mismatch" }, 409);
  }
  const index = session.queuedTurns.findIndex(({ turnId }) => turnId === action.turnId);
  if (index < 0) return json({ error: "queued turn not found" }, 409);
  const queuedTurns = session.queuedTurns.slice();
  queuedTurns.splice(index, 1);
  const next = update(session, { queuedTurns }, now());
  await storage.put(key, next);
  await storage.delete(turnKey(session.sessionId, action.turnId));
  return sessionResponse(next);
}

async function acceptCommand(storage, key, session, action, now) {
  if (!controllerMatches(session, action) || !validId(action.commandId)) {
    return json({ error: "session controller mismatch" }, 409);
  }
  const commandStorageKey = commandKey(session.sessionId, action.commandId);
  const existing = await storage.get(commandStorageKey);
  const fingerprint = commandFingerprint(action);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return json({ error: "command identity conflict" }, 409);
    return sessionResponse(session, { duplicate: true });
  }

  const timestamp = now();
  const transition = await commandTransition(storage, session, action, timestamp);
  if (transition.error) return json({ error: transition.error }, transition.status ?? 409);
  const next = update(session, transition.changes, timestamp);
  const command = {
    commandId: action.commandId,
    generation: session.generation,
    kind: action.kind,
    payload: transition.payload ?? {},
    fingerprint,
    processed: false,
    createdAt: timestamp.toISOString(),
  };
  await storage.put({ [key]: next, [commandStorageKey]: command });
  if (transition.turn) {
    await storage.put(turnKey(session.sessionId, transition.turn.turnId), transition.turn);
  }
  return sessionResponse(next);
}

async function commandTransition(storage, session, action, now) {
  switch (action.kind) {
    case "start": {
      if (session.phase !== "idle" || !validId(action.turnId) || !validText(action.text)) {
        return { error: "start command is not valid" };
      }
      if (await turnExists(storage, session.sessionId, action.turnId)) return { error: "turn already exists" };
      return {
        changes: { phase: "running", activeTurnId: action.turnId },
        turn: { turnId: action.turnId, text: action.text, createdAt: now.toISOString() },
        payload: { turnId: action.turnId, text: action.text },
      };
    }
    case "start_queued": {
      if (session.phase !== "idle" || session.queuedTurns.length === 0) {
        return { error: "no queued turn can start" };
      }
      const [head, ...queuedTurns] = session.queuedTurns;
      const turn = await storage.get(turnKey(session.sessionId, head.turnId));
      if (!turn) return { error: "queued turn payload is missing" };
      return {
        changes: { phase: "running", activeTurnId: head.turnId, queuedTurns },
        payload: { turnId: head.turnId, text: turn.text },
      };
    }
    case "steer":
    case "interrupt":
      return session.phase === "running" && session.activeTurnId
        ? { changes: {} }
        : { error: `${action.kind} command requires a running turn` };
    case "response":
      return session.phase === "waiting_for_user"
        ? { changes: { phase: "running", pendingRequests: [] } }
        : { error: "response command requires a pending request" };
    case "stop":
      return MUTABLE_PHASES.has(session.phase)
        ? { changes: { phase: "stopping" } }
        : { error: "session cannot stop" };
    default:
      return { error: "invalid command kind", status: 400 };
  }
}

async function processCommand(storage, key, session, action, now) {
  if (!validId(action.commandId)) return json({ error: "invalid command" }, 400);
  const commandStorageKey = commandKey(session.sessionId, action.commandId);
  const command = await storage.get(commandStorageKey);
  if (!command || command.generation !== session.generation) return json({ error: "command not found" }, 404);
  if (command.processed) return sessionResponse(session, { duplicate: true });
  const next = update(session, { processedCommandCount: session.processedCommandCount + 1 }, now());
  await storage.put({ [key]: next, [commandStorageKey]: { ...command, processed: true } });
  return sessionResponse(next);
}

async function completeTurn(storage, key, session, action, now) {
  if (session.phase !== "running" || session.activeTurnId !== String(action.turnId)) {
    return json({ error: "active turn mismatch" }, 409);
  }
  const next = update(session, { phase: "idle", activeTurnId: undefined, pendingRequests: [] }, now());
  await appendEvent(storage, next, { type: "turn", data: { turnId: action.turnId, status: "completed" } }, now());
  await storage.put(key, next);
  return sessionResponse(next);
}

async function waitForUser(storage, key, session, action, now) {
  if (session.phase !== "running" || !validId(action.request?.requestId)) {
    return json({ error: "session cannot wait for user" }, 409);
  }
  const event = validateEvent({ type: "request", data: action.request });
  if (!event) return json({ error: "invalid request event" }, 400);
  const pendingRequests = [{ requestId: action.request.requestId, kind: action.request.kind }];
  const next = update(session, { phase: "waiting_for_user", pendingRequests }, now());
  await appendEvent(storage, next, event, now());
  await storage.put(key, next);
  return sessionResponse(next);
}

async function appendPublicEvent(storage, key, session, action, now) {
  const event = validateEvent(action.event);
  if (!event) return json({ error: "invalid public session event" }, 400);
  const timestamp = now();
  await appendEvent(storage, session, event, timestamp);
  const next = update(session, {}, timestamp);
  await storage.put(key, next);
  return sessionResponse(next);
}

async function terminateOne(storage, key, session, action, now) {
  if (session.phase === "terminal") return sessionResponse(session, { duplicate: true });
  if (!TERMINAL_REASONS.has(action.reason)) return json({ error: "invalid terminal reason" }, 400);
  const timestamp = now();
  const next = terminalSession(session, action.reason, timestamp);
  await appendEvent(storage, next, {
    type: "status",
    data: { phase: "terminal", terminalReason: next.terminalReason },
  }, timestamp);
  await storage.put(key, next);
  await scheduleNextExpiry(storage);
  return sessionResponse(next);
}

async function appendEvent(storage, session, input, timestamp) {
  const cursor = session.nextCursor;
  const event = {
    cursor,
    sessionId: session.sessionId,
    type: input.type,
    createdAt: timestamp.toISOString(),
    data: input.data,
  };
  await storage.put(eventKey(session.sessionId, cursor), event);
  session.nextCursor = cursor + 1;
  return event;
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const allowed = EVENT_FIELDS[event.type];
  if (!allowed || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    return undefined;
  }
  if (Object.keys(event).some((key) => !new Set(["type", "data"]).has(key))) return undefined;
  if (Object.keys(event.data).some((key) => !allowed.has(key))) return undefined;
  if (!validEventData(event.type, event.data)) return undefined;
  return { type: event.type, data: structuredClone(event.data) };
}

function validEventData(type, data) {
  const optionalId = (value) => value === undefined || validId(value);
  const optionalText = (value) => value === undefined || boundedText(value);
  switch (type) {
    case "status": {
      const hasStatus = [data.phase, data.channelState, data.controllerGrantId, data.terminalReason]
        .some((value) => value !== undefined);
      return hasStatus &&
        (data.phase === undefined || SESSION_PHASES.has(data.phase)) &&
        (data.channelState === undefined || new Set(["connected", "disconnected"]).has(data.channelState)) &&
        optionalId(data.controllerGrantId) &&
        (data.terminalReason === undefined || TERMINAL_REASONS.has(data.terminalReason));
    }
    case "user_message":
      return boundedText(data.text) && optionalId(data.turnId) &&
        new Set(["steer", "queue"]).has(data.delivery);
    case "agent_message_chunk":
      return boundedText(data.text) && optionalId(data.turnId);
    case "activity":
      return boundedText(data.label) && optionalText(data.target) && optionalText(data.command) &&
        optionalText(data.status) && optionalText(data.error) && optionalId(data.turnId);
    case "request":
      return validId(data.requestId) && boundedText(data.kind) && boundedText(data.title) &&
        new Set(["open", "resolved"]).has(data.state) && optionalText(data.detail) &&
        validRequestChoices(data.choices) && validInputSchema(data.inputSchema);
    case "turn":
      return validId(data.turnId) &&
        new Set(["queued", "started", "completed", "interrupted", "cancelled"]).has(data.status);
    case "error":
      return optionalText(data.scope) && boundedText(data.code) && boundedText(data.message);
    default:
      return false;
  }
}

function validRequestChoices(choices) {
  if (choices === undefined) return true;
  return Array.isArray(choices) && choices.length <= 50 && choices.every((choice) =>
    choice && typeof choice === "object" && !Array.isArray(choice) &&
    Object.keys(choice).every((key) => new Set(["choiceId", "label"]).has(key)) &&
    validId(choice.choiceId) && boundedText(choice.label));
}

function validInputSchema(schema) {
  if (schema === undefined) return true;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (Object.keys(schema).some((key) => !new Set(["type", "properties", "required"]).has(key))) return false;
  if (schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" ||
      Array.isArray(schema.properties) || Object.keys(schema.properties).length > 20) return false;
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!validId(name) || !field || typeof field !== "object" || Array.isArray(field)) return false;
    if (Object.keys(field).some((key) => !new Set(["type", "title", "description", "enum"]).has(key))) {
      return false;
    }
    if (!new Set(["string", "number", "boolean"]).has(field.type) ||
        !optionalBoundedText(field.title) || !optionalBoundedText(field.description)) return false;
    if (field.enum !== undefined &&
        (!Array.isArray(field.enum) || field.enum.length > 50 || !field.enum.every(boundedText))) return false;
  }
  return schema.required === undefined ||
    (Array.isArray(schema.required) && schema.required.every((name) => Object.hasOwn(schema.properties, name)));
}

function boundedText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}

function optionalBoundedText(value) {
  return value === undefined || boundedText(value);
}

function publicSession(session) {
  const result = {
    sessionId: session.sessionId,
    generation: session.generation,
    executor: session.executor,
    phase: session.phase,
    controllerGrantId: session.controllerGrantId,
    workingDirectory: session.workingDirectory,
    queuedTurns: session.queuedTurns,
    pendingRequests: session.pendingRequests,
    latestCursor: session.nextCursor - 1,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  if (session.activeTurnId) result.activeTurnId = session.activeTurnId;
  if (session.terminalReason) result.terminalReason = session.terminalReason;
  if (session.processedCommandCount) result.processedCommandCount = session.processedCommandCount;
  return result;
}

function publicCommand(command) {
  return {
    commandId: command.commandId,
    generation: command.generation,
    kind: command.kind,
    payload: command.payload,
    createdAt: command.createdAt,
  };
}

function update(session, changes, timestamp, nextCursor = session.nextCursor) {
  return { ...session, ...changes, nextCursor, updatedAt: timestamp.toISOString() };
}

function terminalSession(session, reason, timestamp) {
  return update(session, {
    phase: "terminal",
    terminalReason: String(reason),
    activeTurnId: undefined,
    pendingRequests: [],
    expiresAt: new Date(timestamp.getTime() + SESSION_RETENTION_MS).toISOString(),
  }, timestamp);
}

function sessionResponse(session, extra = {}) {
  return json({ session: publicSession(session), ...extra });
}

function controllerMatches(session, action) {
  return validId(action.grantId) && action.grantId === session.controllerGrantId;
}

function commandFingerprint(action) {
  return JSON.stringify({
    generation: String(action.generation),
    grantId: String(action.grantId),
    kind: String(action.kind),
    turnId: action.turnId === undefined ? undefined : String(action.turnId),
    text: action.text === undefined ? undefined : String(action.text),
  });
}

async function turnExists(storage, sessionId, turnId) {
  return Boolean(await storage.get(turnKey(sessionId, turnId)));
}

async function deleteSession(storage, metadataKey, sessionId) {
  const keys = [metadataKey];
  for (const prefix of [eventPrefix(sessionId), turnPrefix(sessionId), commandPrefix(sessionId)]) {
    const values = await listAll(storage, prefix);
    keys.push(...values.keys());
  }
  await storage.delete(keys);
}

async function listAll(storage, prefix) {
  const result = new Map();
  let startAfter = "";
  while (true) {
    const page = await storage.list({ prefix, startAfter, limit: 1_000 });
    for (const [key, value] of page) result.set(key, value);
    if (page.size < 1_000) return result;
    startAfter = [...page.keys()].at(-1);
  }
}

async function scheduleNextExpiry(storage) {
  const values = await listAll(storage, SESSION_META_PREFIX);
  let nextExpiry;
  for (const session of values.values()) {
    if (session.phase === "terminal" && session.expiresAt) {
      nextExpiry = minDate(nextExpiry, session.expiresAt);
    }
  }
  if (nextExpiry) await storage.setAlarm(new Date(nextExpiry));
}

function metaKey(sessionId) {
  return `${SESSION_META_PREFIX}${sessionId}`;
}

function eventPrefix(sessionId) {
  return `${SESSION_EVENT_PREFIX}${sessionId}:`;
}

function eventKey(sessionId, cursor) {
  return `${eventPrefix(sessionId)}${String(cursor).padStart(16, "0")}`;
}

function turnPrefix(sessionId) {
  return `${SESSION_TURN_PREFIX}${sessionId}:`;
}

function turnKey(sessionId, turnId) {
  return `${turnPrefix(sessionId)}${turnId}`;
}

function commandPrefix(sessionId) {
  return `${SESSION_COMMAND_PREFIX}${sessionId}:`;
}

function commandKey(sessionId, commandId) {
  return `${commandPrefix(sessionId)}${commandId}`;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validText(value) {
  return typeof value === "string" && value.length > 0;
}

function parseNonNegativeInteger(value, fallback) {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseNonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function minDate(current, candidate) {
  if (!current) return candidate;
  return new Date(candidate).getTime() < new Date(current).getTime() ? candidate : current;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
