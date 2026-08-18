import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_RETENTION_MS,
  expireSessions,
  handleSessionRequest,
  terminateGenerationSessions,
} from "../apps/chatgpt-app/src/session-state.js";

const CREATED_AT = "2026-08-18T00:00:00.000Z";

test("EnvironmentObject Session store creates, lists, and reads private ordered events", async () => {
  const storage = fakeStorage();
  const created = await sessionRequest(storage, "POST", "/sessions", {
    sessionId: "session-1",
    generation: "generation-1",
    controllerGrantId: "grant-a",
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

test("Session controller takeover atomically rejects the old Grant", async () => {
  const storage = await admittedSession();
  assert.equal((await sessionAction(storage, {
    type: "take_over",
    generation: "generation-1",
    grantId: "grant-b",
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
      executor: "codex",
      workingDirectory: "/home/runner",
    })).status, 201);
  }
  assert.equal((await sessionRequest(ownerB, "POST", "/sessions", {
    sessionId: "session-b1",
    generation: "generation-1",
    controllerGrantId: "grant-b",
    executor: "grok",
    workingDirectory: "/home/runner",
  })).status, 201);

  const ownerASessions = (await (await sessionRequest(ownerA, "GET", "/sessions")).json()).sessions;
  const ownerBSessions = (await (await sessionRequest(ownerB, "GET", "/sessions")).json()).sessions;
  assert.deepEqual(ownerASessions.map(({ sessionId }) => sessionId), ["session-a1", "session-a2"]);
  assert.deepEqual(ownerBSessions.map(({ sessionId }) => sessionId), ["session-b1"]);
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
