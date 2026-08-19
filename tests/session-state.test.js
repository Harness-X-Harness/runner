import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ACTIVE_SESSIONS,
  MAX_QUEUED_TURNS,
  MAX_SESSION_COMMANDS,
  MAX_SESSION_EVENTS,
  SESSION_RETENTION_MS,
  environmentTerminalReason,
  expireSessions,
  handleSessionRequest,
  pendingGenerationCommands,
  startGenerationQueuedTurns,
  terminateGenerationSessions,
} from "../apps/chatgpt-app/src/session-state.js";

const CREATED_AT = "2026-08-18T00:00:00.000Z";

test("Environment terminal reason distinguishes startup failure, normal end, and explicit stop", () => {
  assert.equal(environmentTerminalReason({ status: "starting", closeRequested: false }), "startup_failed");
  assert.equal(environmentTerminalReason({ status: "ready", closeRequested: false }), "environment_ended");
  assert.equal(environmentTerminalReason({ status: "closing", closeRequested: true }), "stopped");
});

test("EnvironmentObject Session store creates, lists, and reads private ordered events", async () => {
  const storage = fakeStorage();
  const created = await sessionRequest(storage, "POST", "/sessions", {
    sessionId: "session-1",
    generation: "generation-1",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    executor: "codex",
    workingDirectory: "/home/runner",
  });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).session, {
    sessionId: "session-1",
    generation: "generation-1",
    executor: "codex",
    phase: "preparing",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    workingDirectory: "/home/runner",
    queuedTurns: [],
    pendingRequests: [],
    latestCursor: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  const listed = await sessionRequest(storage, "GET", "/sessions");
  const listBody = await listed.json();
  assert.equal(listBody.sessions.length, 1);
  assert.equal(listBody.sessions[0].sessionId, "session-1");
  assert.equal(JSON.stringify(listBody), JSON.stringify(listBody).replace(/prompt|credential/g, ""));

  const read = await sessionRequest(storage, "GET", "/sessions/session-1?after=0&limit=10");
  const body = await read.json();
  assert.equal(body.events.length, 1);
  assert.deepEqual(body.events[0], {
    cursor: 1,
    sessionId: "session-1",
    type: "status",
    createdAt: CREATED_AT,
    data: { phase: "preparing" },
  });
  assert.equal(body.nextCursor, 1);
  assert.equal(body.hasMore, false);
});

test("Session creation requires an absolute bounded working directory", async () => {
  for (const workingDirectory of ["workspace", `/${"x".repeat(65_536)}`]) {
    const response = await sessionRequest(fakeStorage(), "POST", "/sessions", {
      sessionId: "session-1",
      generation: "generation-1",
      controllerGrantId: "grant-a",
      controllerClientName: "Client A",
      executor: "codex",
      workingDirectory,
    });
    assert.equal(response.status, 400);
  }
});

test("Session controller takeover atomically rejects the old Grant", async () => {
  const storage = await admittedSession();
  assert.equal((await sessionAction(storage, {
    type: "take_over",
    generation: "generation-1",
    grantId: "grant-b",
    clientName: "Client B",
  })).status, 200);

  const rejected = await sessionAction(storage, {
    type: "queue_turn",
    generation: "generation-1",
    grantId: "grant-a",
    turnId: "turn-old",
    text: "old controller",
  });
  assert.equal(rejected.status, 409);

  const accepted = await sessionAction(storage, {
    type: "queue_turn",
    generation: "generation-1",
    grantId: "grant-b",
    turnId: "turn-new",
    text: "new controller",
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).session.queuedTurns, [
    { turnId: "turn-new", createdAt: CREATED_AT },
  ]);
});

test("owner-scoped stores isolate Sessions while one owner can list several", async () => {
  const ownerA = fakeStorage();
  const ownerB = fakeStorage();
  for (const sessionId of ["session-a1", "session-a2"]) {
    assert.equal((await sessionRequest(ownerA, "POST", "/sessions", {
      sessionId,
      generation: "generation-1",
      controllerGrantId: "grant-a",
      controllerClientName: "Client A",
      executor: "codex",
      workingDirectory: "/home/runner",
    })).status, 201);
  }
  assert.equal((await sessionRequest(ownerB, "POST", "/sessions", {
    sessionId: "session-b1",
    generation: "generation-1",
    controllerGrantId: "grant-b",
    controllerClientName: "Client B",
    executor: "grok",
    workingDirectory: "/home/runner",
  })).status, 201);

  const ownerASessions = (await (await sessionRequest(ownerA, "GET", "/sessions")).json()).sessions;
  const ownerBSessions = (await (await sessionRequest(ownerB, "GET", "/sessions")).json()).sessions;
  assert.deepEqual(ownerASessions.map(({ sessionId }) => sessionId), ["session-a1", "session-a2"]);
  assert.deepEqual(ownerBSessions.map(({ sessionId }) => sessionId), ["session-b1"]);
});

test("Environment rejects a Session beyond the active driver budget", async () => {
  const storage = fakeStorage();
  for (let index = 0; index < MAX_ACTIVE_SESSIONS; index += 1) {
    assert.equal((await sessionRequest(storage, "POST", "/sessions", {
      sessionId: `session-${index}`,
      generation: "generation-1",
      controllerGrantId: "grant-a",
      controllerClientName: "Client A",
      executor: "codex",
      workingDirectory: "/home/runner",
    })).status, 201);
  }
  const rejected = await sessionRequest(storage, "POST", "/sessions", {
    sessionId: "session-overflow",
    generation: "generation-1",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    executor: "codex",
    workingDirectory: "/home/runner",
  });
  assert.equal(rejected.status, 429);
  assert.equal((await (await sessionRequest(storage, "GET", "/sessions")).json()).sessions.length,
    MAX_ACTIVE_SESSIONS);
});

test("explicit queued turns remain FIFO and cancel only before start", async () => {
  const storage = await admittedSession();
  for (const [turnId, text] of [["turn-a", "first"], ["turn-b", "second"]]) {
    assert.equal((await sessionAction(storage, {
      type: "queue_turn",
      generation: "generation-1",
      grantId: "grant-a",
      turnId,
      text,
    })).status, 200);
  }
  assert.equal((await sessionAction(storage, {
    type: "cancel_queued_turn",
    generation: "generation-1",
    grantId: "grant-a",
    turnId: "turn-b",
  })).status, 200);

  const started = await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-a",
    kind: "start_queued",
  });
  const startedBody = await started.json();
  assert.equal(startedBody.session.activeTurnId, "turn-a");
  assert.deepEqual(startedBody.session.queuedTurns, []);

  const tooLate = await sessionAction(storage, {
    type: "cancel_queued_turn",
    generation: "generation-1",
    grantId: "grant-a",
    turnId: "turn-a",
  });
  assert.equal(tooLate.status, 409);
});

test("a queued-input overflow is rejected and terminates only that Session", async () => {
  const storage = await admittedSession();
  for (let index = 0; index < MAX_QUEUED_TURNS; index += 1) {
    assert.equal((await sessionAction(storage, {
      type: "queue_turn",
      generation: "generation-1",
      grantId: "grant-a",
      turnId: `turn-${index}`,
      text: `queued ${index}`,
    })).status, 200);
  }
  const rejected = await sessionAction(storage, {
    type: "queue_turn",
    generation: "generation-1",
    grantId: "grant-a",
    turnId: "turn-overflow",
    text: "must be rejected",
  });
  const body = await rejected.json();
  assert.equal(rejected.status, 429);
  assert.equal(body.session.phase, "terminal");
  assert.equal(body.session.terminalReason, "resource_exhausted");
  assert.deepEqual(body.session.queuedTurns, []);
});

test("a command-receipt overflow cannot create another native effect", async () => {
  const storage = await admittedSession();
  assert.equal((await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-start",
    kind: "start",
    turnId: "turn-active",
    text: "start",
  })).status, 200);
  for (let index = 1; index < MAX_SESSION_COMMANDS; index += 1) {
    assert.equal((await sessionAction(storage, {
      type: "accept_command",
      generation: "generation-1",
      grantId: "grant-a",
      commandId: `command-interrupt-${index}`,
      kind: "interrupt",
      turnId: "turn-active",
    })).status, 200);
  }
  const rejected = await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-overflow",
    kind: "interrupt",
    turnId: "turn-active",
  });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).session.terminalReason, "resource_exhausted");
});

test("event retention drops old Agent chunks but terminalizes non-recoverable overflow", async () => {
  const storage = await admittedSession();
  for (let index = 0; index < MAX_SESSION_EVENTS - 2; index += 1) {
    assert.equal((await sessionAction(storage, {
      type: "append_event",
      generation: "generation-1",
      event: {
        type: "agent_message_chunk",
        data: { turnId: "turn-output", text: `chunk-${index}` },
      },
    })).status, 200);
  }
  const retained = await sessionAction(storage, {
    type: "append_event",
    generation: "generation-1",
    event: {
      type: "agent_message_chunk",
      data: { turnId: "turn-output", text: "latest-chunk" },
    },
  });
  assert.equal(retained.status, 200);
  const latest = await sessionRequest(
    storage,
    "GET",
    `/sessions/session-1?after=${MAX_SESSION_EVENTS - 1}&limit=2`,
  );
  assert.equal((await latest.json()).events.at(-1).data.text, "latest-chunk");

  const controls = await admittedSession();
  for (let index = 0; index < MAX_SESSION_EVENTS - 3; index += 1) {
    assert.equal((await sessionAction(controls, {
      type: "append_event",
      generation: "generation-1",
      event: {
        type: "activity",
        data: { label: `control-${index}`, status: "completed" },
      },
    })).status, 200);
  }
  const exhausted = await sessionAction(controls, {
    type: "append_event",
    generation: "generation-1",
    event: { type: "error", data: { scope: "driver", code: "late", message: "critical" } },
  });
  assert.equal(exhausted.status, 429);
  assert.equal((await exhausted.json()).session.terminalReason, "resource_exhausted");
});

test("duplicate command delivery records one native effect", async () => {
  const storage = await admittedSession();
  const accepted = {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-a",
    kind: "start",
    turnId: "turn-a",
    text: "inspect the repository",
  };
  assert.equal((await sessionAction(storage, accepted)).status, 200);
  const duplicateAcceptance = await sessionAction(storage, accepted);
  assert.equal(duplicateAcceptance.status, 200);
  assert.equal((await duplicateAcceptance.json()).duplicate, true);

  const conflictingAcceptance = await sessionAction(storage, { ...accepted, text: "different effect" });
  assert.equal(conflictingAcceptance.status, 409);

  const pending = await sessionRequest(storage, "GET", "/sessions/session-1/commands");
  assert.deepEqual((await pending.json()).commands.map(({ commandId }) => commandId), ["command-a"]);
  assert.deepEqual(
    (await pendingGenerationCommands(storage, "generation-1")).map(({ sessionId, commandId }) => ({
      sessionId,
      commandId,
    })),
    [{ sessionId: "session-1", commandId: "command-a" }],
  );

  const processed = {
    type: "process_command",
    generation: "generation-1",
    commandId: "command-a",
  };
  assert.equal((await sessionAction(storage, processed)).status, 200);
  const duplicateProcessing = await sessionAction(storage, processed);
  const duplicateBody = await duplicateProcessing.json();
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.session.processedCommandCount, 1);
  assert.deepEqual(
    (await (await sessionRequest(storage, "GET", "/sessions/session-1/commands")).json()).commands,
    [],
  );
  assert.deepEqual(await pendingGenerationCommands(storage, "generation-1"), []);
});

test("runner admission refines preparing into one exact native turn", async () => {
  const storage = fakeStorage();
  await sessionRequest(storage, "POST", "/sessions", {
    sessionId: "session-1",
    generation: "generation-1",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    executor: "grok",
    workingDirectory: "/home/runner",
    startCommandId: "command-start",
    initialTurnId: "turn-1",
    initialPrompt: "initial prompt",
  });
  assert.equal((await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "another-start",
    kind: "start",
  })).status, 409);

  const [pending] = await pendingGenerationCommands(storage, "generation-1");
  assert.deepEqual(pending, {
    sessionId: "session-1",
    executor: "grok",
    workingDirectory: "/home/runner",
    commandId: "command-start",
    generation: "generation-1",
    kind: "start",
    payload: { initial: true, turnId: "turn-1", text: "initial prompt" },
    createdAt: CREATED_AT,
  });

  assert.equal((await sessionAction(storage, {
    type: "admit",
    generation: "generation-1",
  })).status, 200);
  const begun = await sessionAction(storage, {
    type: "begin_turn",
    generation: "generation-1",
    turnId: "turn-1",
  });
  assert.equal((await begun.json()).session.activeTurnId, "turn-1");

  const waiting = await sessionAction(storage, {
    type: "wait_for_user",
    generation: "generation-1",
    turnId: "turn-1",
    request: {
      requestId: "request-1",
      state: "open",
      kind: "permission",
      title: "Allow command",
      choices: [{ choiceId: "allow-once", label: "Allow once" }],
    },
  });
  assert.equal((await waiting.json()).session.phase, "waiting_for_user");

  assert.equal((await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-response",
    kind: "response",
    requestId: "request-stale",
    choiceId: "allow-once",
  })).status, 409);
  assert.equal((await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-undeclared-choice",
    kind: "response",
    requestId: "request-1",
    choiceId: "allow-always",
  })).status, 409);
  const response = await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-response",
    kind: "response",
    requestId: "request-1",
    choiceId: "allow-once",
  });
  assert.equal((await response.json()).session.phase, "running");

  const completed = await sessionAction(storage, {
    type: "complete_turn",
    generation: "generation-1",
    turnId: "turn-1",
    status: "failed",
  });
  assert.equal((await completed.json()).session.phase, "idle");
  const read = await sessionRequest(storage, "GET", "/sessions/session-1?after=0&limit=100");
  assert.deepEqual((await read.json()).events.filter(({ type }) => type === "turn").map(({ data }) => data), [
    { turnId: "turn-1", status: "started" },
    { turnId: "turn-1", status: "failed" },
  ]);
});

test("a completed turn atomically starts the FIFO head without another client command", async () => {
  const storage = await admittedSession();
  assert.equal((await sessionAction(storage, {
    type: "accept_command",
    generation: "generation-1",
    grantId: "grant-a",
    commandId: "command-running",
    kind: "start",
    turnId: "turn-running",
    text: "first",
  })).status, 200);
  assert.equal((await sessionAction(storage, {
    type: "queue_turn",
    generation: "generation-1",
    grantId: "grant-a",
    turnId: "turn-queued",
    text: "second",
  })).status, 200);

  const completed = await sessionAction(storage, {
    type: "complete_turn",
    generation: "generation-1",
    turnId: "turn-running",
    status: "completed",
  });
  const body = await completed.json();
  assert.equal(body.session.phase, "running");
  assert.equal(body.session.activeTurnId, "turn-queued");
  assert.deepEqual(body.session.queuedTurns, []);
  const pending = await pendingGenerationCommands(storage, "generation-1");
  const queued = pending.find(({ kind }) => kind === "start_queued");
  assert.ok(queued);
  assert.deepEqual(queued.payload, { turnId: "turn-queued", text: "second" });
});

test("a connected generation starts an explicitly queued idle turn exactly once", async () => {
  const storage = fakeStorage();
  const sessionId = "session-idle-queue";
  await sessionRequest(storage, "POST", "/sessions", {
    sessionId,
    generation: "generation-1",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    executor: "codex",
    workingDirectory: "/home/runner",
  });
  await sessionRequest(storage, "POST", `/sessions/${sessionId}`, {
    type: "admit",
    generation: "generation-1",
  });
  await sessionRequest(storage, "POST", `/sessions/${sessionId}`, {
    type: "queue_turn",
    generation: "generation-1",
    grantId: "grant-a",
    turnId: "turn-idle",
    text: "Run when connected",
  });

  assert.equal(await startGenerationQueuedTurns(storage, "generation-1"), 1);
  assert.equal(await startGenerationQueuedTurns(storage, "generation-1"), 0);
  const current = await (await sessionRequest(
    storage,
    "GET",
    `/sessions/${sessionId}`,
  )).json();
  assert.equal(current.session.phase, "running");
  assert.equal(current.session.activeTurnId, "turn-idle");
  assert.deepEqual(current.session.queuedTurns, []);
  assert.equal((await pendingGenerationCommands(storage, "generation-1"))
    .filter(({ kind }) => kind === "start_queued").length, 1);
});

test("generation gates and terminal monotonicity reject stale Session mutations", async () => {
  const storage = await admittedSession();
  const stale = await sessionAction(storage, {
    type: "queue_turn",
    generation: "generation-2",
    grantId: "grant-a",
    turnId: "turn-stale",
    text: "must not enter the old environment",
  });
  assert.equal(stale.status, 409);

  const terminated = await sessionAction(storage, {
    type: "terminate",
    generation: "generation-1",
    reason: "environment_ended",
  });
  assert.equal((await terminated.json()).session.phase, "terminal");

  const late = await sessionAction(storage, {
    type: "append_event",
    generation: "generation-1",
    event: { type: "agent_message_chunk", data: { text: "late output" } },
  });
  assert.equal(late.status, 409);
});

test("Session Events accept bounded public semantics and reject private native content", async () => {
  const storage = await admittedSession();
  assert.equal((await sessionAction(storage, {
    type: "append_event",
    generation: "generation-1",
    event: { type: "agent_message_chunk", data: { text: "Visible answer" } },
  })).status, 200);
  for (const event of [
    { type: "thought", data: { text: "private reasoning" } },
    { type: "agent_message_chunk", data: { reasoning: "private" } },
    { type: "activity", data: { label: "shell", stdout: "secret" } },
  ]) {
    assert.equal((await sessionAction(storage, {
      type: "append_event",
      generation: "generation-1",
      event,
    })).status, 400);
  }

  const read = await sessionRequest(storage, "GET", "/sessions/session-1?after=0&limit=100");
  const serialized = JSON.stringify(await read.json());
  assert.doesNotMatch(serialized, /private reasoning|stdout|secret/);
  assert.match(serialized, /Visible answer/);
});

test("read_session pagination preserves monotonic cursors", async () => {
  const storage = await admittedSession();
  for (const text of ["one", "two", "three"]) {
    await sessionAction(storage, {
      type: "append_event",
      generation: "generation-1",
      event: { type: "agent_message_chunk", data: { text } },
    });
  }
  const first = await sessionRequest(storage, "GET", "/sessions/session-1?after=0&limit=2");
  const firstBody = await first.json();
  assert.deepEqual(firstBody.events.map(({ cursor }) => cursor), [1, 2]);
  assert.equal(firstBody.nextCursor, 2);
  assert.equal(firstBody.hasMore, true);

  const second = await sessionRequest(storage, "GET", "/sessions/session-1?after=2&limit=10");
  const secondBody = await second.json();
  assert.deepEqual(secondBody.events.map(({ cursor }) => cursor), [3, 4, 5]);
  assert.equal(secondBody.nextCursor, 5);
  assert.equal(secondBody.hasMore, false);
});

test("terminal Sessions expire after seven days and not before", async () => {
  let now = new Date(CREATED_AT);
  const storage = await admittedSession(() => now);
  await sessionAction(storage, {
    type: "terminate",
    generation: "generation-1",
    reason: "stopped",
  }, () => now);
  const firstExpiry = storage.alarm.toISOString();

  now = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  await sessionRequest(storage, "POST", "/sessions", {
    sessionId: "session-2",
    generation: "generation-1",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    executor: "grok",
    workingDirectory: "/home/runner",
  }, () => now);
  await sessionRequest(storage, "POST", "/sessions/session-2", {
    type: "terminate",
    generation: "generation-1",
    reason: "stopped",
  }, () => now);
  assert.equal(storage.alarm.toISOString(), firstExpiry);

  now = new Date(CREATED_AT);
  now = new Date(now.getTime() + SESSION_RETENTION_MS - 1);
  assert.equal(await expireSessions(storage, { now: () => now }), 0);
  assert.equal((await sessionRequest(storage, "GET", "/sessions/session-1")).status, 200);

  now = new Date(now.getTime() + 1);
  assert.equal(await expireSessions(storage, { now: () => now }), 1);
  assert.equal((await sessionRequest(storage, "GET", "/sessions/session-1")).status, 404);
  assert.equal((await sessionRequest(storage, "GET", "/sessions/session-2")).status, 200);
});

test("Environment termination affects only Sessions from the exact generation", async () => {
  const storage = fakeStorage();
  for (const [sessionId, generation] of [["session-old", "generation-1"], ["session-new", "generation-2"]]) {
    await sessionRequest(storage, "POST", "/sessions", {
      sessionId,
      generation,
      controllerGrantId: "grant-a",
      controllerClientName: "Client A",
      executor: "codex",
      workingDirectory: "/home/runner",
    });
  }

  assert.equal(await terminateGenerationSessions(
    storage,
    "generation-1",
    "environment_ended",
    { now: () => new Date(CREATED_AT) },
  ), 1);
  const oldSession = (await (await sessionRequest(storage, "GET", "/sessions/session-old")).json()).session;
  const newSession = (await (await sessionRequest(storage, "GET", "/sessions/session-new")).json()).session;
  assert.equal(oldSession.phase, "terminal");
  assert.equal(oldSession.terminalReason, "environment_ended");
  assert.equal(newSession.phase, "preparing");
});

async function admittedSession(now = () => new Date(CREATED_AT)) {
  const storage = fakeStorage();
  await sessionRequest(storage, "POST", "/sessions", {
    sessionId: "session-1",
    generation: "generation-1",
    controllerGrantId: "grant-a",
    controllerClientName: "Client A",
    executor: "codex",
    workingDirectory: "/home/runner",
  }, now);
  assert.equal((await sessionAction(storage, {
    type: "admit",
    generation: "generation-1",
  }, now)).status, 200);
  return storage;
}

function sessionAction(storage, action, now = () => new Date(CREATED_AT)) {
  return sessionRequest(storage, "POST", "/sessions/session-1", action, now);
}

function sessionRequest(storage, method, path, body, now = () => new Date(CREATED_AT)) {
  return handleSessionRequest(
    storage,
    new Request(`https://environment${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { now },
  );
}

function fakeStorage() {
  const values = new Map();
  return {
    alarm: undefined,
    async get(key) {
      if (Array.isArray(key)) {
        return new Map(key.filter((item) => values.has(item)).map((item) => [item, clone(values.get(item))]));
      }
      return values.has(key) ? clone(values.get(key)) : undefined;
    },
    async put(key, value) {
      if (typeof key === "object") {
        for (const [itemKey, itemValue] of Object.entries(key)) values.set(itemKey, clone(itemValue));
      } else {
        values.set(key, clone(value));
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    async list({ prefix = "", startAfter = "", limit = 1_000 } = {}) {
      return new Map(
        [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, limit)
          .map(([key, value]) => [key, clone(value)]),
      );
    },
    async transaction(callback) {
      return callback(this);
    },
    async setAlarm(value) {
      this.alarm = new Date(value);
    },
  };
}

function clone(value) {
  return structuredClone(value);
}
