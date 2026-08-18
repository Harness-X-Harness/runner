import assert from "node:assert/strict";
import test from "node:test";

import { channelAllowsSessionAction } from "../apps/chatgpt-app/src/environment-channel.js";
import { handleMcpRequest } from "../apps/chatgpt-app/src/mcp.js";
import {
  handleSessionRequest,
  pendingGenerationCommands,
} from "../apps/chatgpt-app/src/session-state.js";
import { startAgentSession } from "../apps/chatgpt-app/src/session.js";

const OWNER = "42";
const GENERATION = "generation-1";

test("nine Session tools expose one executor-neutral OAuth contract", async () => {
  const harness = fakeHarness();
  const tools = await listTools(harness.env, grant("grant-a", "ChatGPT"));
  const names = [
    "start_session",
    "list_sessions",
    "read_session",
    "send_turn",
    "cancel_queued_turn",
    "interrupt_turn",
    "respond_to_session",
    "take_over_session",
    "stop_session",
  ];
  for (const name of names) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["sessions:manage"] }]);
    assert.doesNotMatch(JSON.stringify(tool), /tasks:|repos:|pull_requests:|app-server|ACP|WebSocket/);
  }
  assert.equal(tools.find(({ name }) => name === "send_turn")
    .inputSchema.properties.delivery.default, undefined);
  assert.deepEqual(tools.find(({ name }) => name === "start_session")
    .inputSchema.properties.executor.enum, ["codex", "grok"]);
});

test("Session MCP tools preserve owner, controller, exact IDs, queue order, and private output", async () => {
  const harness = fakeHarness();
  const grantA = grant("grant-a", "ChatGPT");
  const grantB = grant("grant-b", "VS Code");
  const started = structured(await callTool(harness.env, grantA, "start_session", {
    executor: "codex",
    workingDirectory: "/home/runner/workspace",
  }));
  const sessionId = started.sessionId;
  assert.equal(started.phase, "preparing");
  assert.equal(started.controller.clientName, "ChatGPT");
  assert.equal(started.controller.currentGrant, true);
  assert.equal(started.channelState, "connected");
  assert.equal(started.environment.status, "ready");
  assert.doesNotMatch(JSON.stringify(started), /generation-1|grant-a|ghu_|pairing|tailscale|token/i);

  const pending = await pendingGenerationCommands(harness.storage(OWNER), GENERATION);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].executor, "codex");
  assert.equal(pending[0].kind, "start");
  assert.deepEqual(pending[0].payload, { initial: true });

  await runnerAction(harness, sessionId, { type: "admit" });
  const listedByB = structured(await callTool(harness.env, grantB, "list_sessions", {}));
  assert.equal(listedByB.sessions.length, 1);
  assert.equal(listedByB.sessions[0].controller.currentGrant, false);
  assert.equal(Object.hasOwn(listedByB.sessions[0], "events"), false);

  const taken = structured(await callTool(harness.env, grantB, "take_over_session", { sessionId }));
  assert.deepEqual(taken.controller, { clientName: "VS Code", currentGrant: true });
  assert.equal((await callTool(harness.env, grantA, "send_turn", {
    sessionId,
    text: "old controller must fail",
  })).result.isError, true);

  const sent = structured(await callTool(harness.env, grantB, "send_turn", {
    sessionId,
    text: "first turn",
  }));
  assert.equal(sent.delivery, "steer");
  assert.equal(sent.session.phase, "running");
  const activeTurnId = sent.turnId;

  harness.environment(OWNER).channelState = "disconnected";
  assert.equal((await callTool(harness.env, grantB, "send_turn", {
    sessionId,
    text: "must not silently queue",
  })).result.isError, true);
  const queued = structured(await callTool(harness.env, grantB, "send_turn", {
    sessionId,
    text: "explicit queued turn",
    delivery: "queue",
  }));
  assert.equal(queued.delivery, "queue");
  assert.equal(queued.session.queuedTurns.length, 1);
  const cancelled = structured(await callTool(harness.env, grantB, "cancel_queued_turn", {
    sessionId,
    turnId: queued.turnId,
  }));
  assert.deepEqual(cancelled.queuedTurns, []);

  const next = structured(await callTool(harness.env, grantB, "send_turn", {
    sessionId,
    text: "next queued turn",
    delivery: "queue",
  }));
  harness.environment(OWNER).channelState = "connected";
  await runnerAction(harness, sessionId, {
    type: "complete_turn",
    turnId: activeTurnId,
    status: "completed",
  });
  const runningNext = structured(await callTool(harness.env, grantB, "read_session", {
    sessionId,
    afterCursor: 0,
    limit: 100,
  }));
  assert.equal(runningNext.session.activeTurnId, next.turnId);
  assert.equal(runningNext.events.every((event, index, events) =>
    index === 0 || event.cursor > events[index - 1].cursor), true);
  assert.match(JSON.stringify(runningNext.events), /next queued turn/);
  assert.doesNotMatch(JSON.stringify(runningNext), /grant-b|generation-1|command_/);

  assert.equal((await callTool(harness.env, grantB, "interrupt_turn", {
    sessionId,
    activeTurnId: "stale-turn",
  })).result.isError, true);
  const interrupted = structured(await callTool(harness.env, grantB, "interrupt_turn", {
    sessionId,
    activeTurnId: next.turnId,
  }));
  assert.equal(interrupted.phase, "running");
  await runnerAction(harness, sessionId, {
    type: "complete_turn",
    turnId: next.turnId,
    status: "interrupted",
  });

  const questionTurn = structured(await callTool(harness.env, grantB, "send_turn", {
    sessionId,
    text: "ask a question",
  }));
  await runnerAction(harness, sessionId, {
    type: "wait_for_user",
    turnId: questionTurn.turnId,
    request: {
      requestId: "request-1",
      state: "open",
      kind: "input",
      title: "Choose branch",
      inputSchema: {
        type: "object",
        properties: { branch: { type: "string", title: "Branch" } },
        required: ["branch"],
      },
    },
  });
  const answered = structured(await callTool(harness.env, grantB, "respond_to_session", {
    sessionId,
    requestId: "request-1",
    values: { branch: "main" },
  }));
  assert.equal(answered.phase, "running");
  assert.deepEqual(answered.pendingRequests, []);

  await runnerAction(harness, sessionId, {
    type: "complete_turn",
    turnId: questionTurn.turnId,
    status: "completed",
  });
  const stopping = structured(await callTool(harness.env, grantB, "stop_session", { sessionId }));
  assert.equal(stopping.phase, "stopping");
  await runnerAction(harness, sessionId, { type: "terminate", reason: "stopped" });
  const terminal = structured(await callTool(harness.env, grantB, "read_session", { sessionId }));
  assert.equal(terminal.session.phase, "terminal");
  assert.equal(terminal.session.terminalReason, "stopped");

  const other = structured(await callTool(harness.env, {
    ...grantA,
    githubUserId: "43",
  }, "list_sessions", {}));
  assert.deepEqual(other.sessions, []);
});

test("Session tools reject missing Session scope and do not return control credentials", async () => {
  const harness = fakeHarness();
  const denied = await callTool(harness.env, {
    ...grant("grant-a", "ChatGPT"),
    oauthScopes: ["environments:manage"],
  }, "list_sessions", {});
  assert.equal(denied.result.isError, true);
  assert.doesNotMatch(JSON.stringify(denied), /mcpControllerGrantId|environmentGithubAccessToken|ghu_scoped/);
});

test("offline and closing Environment starts keep one stable preparing Session identity", async () => {
  const harness = fakeHarness();
  const controller = { grantId: "grant-a", clientName: "ChatGPT" };
  harness.setEnvironment(OWNER, undefined);
  const dispatches = [];
  const first = await startAgentSession(
    harness.env,
    OWNER,
    controller,
    { executor: "codex" },
    async (_env, request) => {
      dispatches.push(request);
      return { runId: "run-1", runUrl: "https://github.com/example/actions/runs/1" };
    },
    async () => {},
    async () => "generation-new",
  );
  assert.equal(first.phase, "preparing");
  assert.equal(first.environment.status, "starting");
  assert.deepEqual(dispatches, [{
    environmentId: "generation-new",
    environmentOwner: `slot-${OWNER}`,
  }]);

  harness.setEnvironment(OWNER, {
    ownerId: OWNER,
    generation: "generation-old",
    status: "closing",
    slot: `slot-${OWNER}`,
    runId: "run-old",
  });
  const waiting = await startAgentSession(
    harness.env,
    OWNER,
    controller,
    { executor: "grok", initialPrompt: "Wait for replacement" },
    async () => { throw new Error("closing must not dispatch yet"); },
    async () => {},
    async () => "generation-replacement",
  );
  assert.equal(waiting.phase, "preparing");
  assert.equal(waiting.environment.status, "closing");
  assert.equal(harness.environment(OWNER).replacementGeneration, "generation-replacement");
});

async function listTools(env, props) {
  const response = await mcpRequest(env, props, 1, "tools/list", {});
  return response.result.tools;
}

function callTool(env, props, name, args) {
  return mcpRequest(env, props, crypto.randomUUID(), "tools/call", {
    name,
    arguments: args,
  });
}

async function mcpRequest(env, props, id, method, params) {
  const response = await handleMcpRequest(
    new Request("https://runner.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": "2026-07-28",
        ...(method === "tools/call" ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "contract-test", version: "1.0.0" },
          },
        },
      }),
    }),
    env,
    props,
    { props },
  );
  assert.equal(response.status, 200);
  return response.json();
}

function structured(response) {
  assert.equal(response.result.isError, undefined, JSON.stringify(response.result.content));
  return response.result.structuredContent;
}

function grant(grantId, clientName) {
  return {
    githubUserId: OWNER,
    oauthScopes: ["sessions:manage"],
    mcpControllerGrantId: grantId,
    mcpClientName: clientName,
    githubAuthorizationKind: "github_app_scoped",
    environmentGithubAccessToken: "ghu_scoped",
  };
}

async function runnerAction(harness, sessionId, action) {
  const response = await handleSessionRequest(
    harness.storage(OWNER),
    new Request(`https://environment/sessions/${sessionId}`, {
      method: "POST",
      body: JSON.stringify({ generation: GENERATION, ...action }),
    }),
  );
  assert.equal(response.status, 200, await response.text());
}

function fakeHarness() {
  const owners = new Map();
  const owner = (ownerId) => {
    if (!owners.has(ownerId)) {
      owners.set(ownerId, {
        environment: ownerId === OWNER
          ? {
              ownerId,
              generation: GENERATION,
              status: "ready",
              channelState: "connected",
              runUrl: "https://github.com/Harness-X-Harness/runner/actions/runs/123",
            }
          : undefined,
        storage: fakeStorage(),
      });
    }
    return owners.get(ownerId);
  };
  const binding = {
    idFromName: (name) => name,
    get: (name) => {
      const ownerId = String(name).replace(/^github-/, "");
      return {
        fetch: async (input, init) => {
          const state = owner(ownerId);
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/environment" && request.method === "GET") {
            return state.environment
              ? Response.json(state.environment)
              : Response.json({ error: "environment not found" }, { status: 404 });
          }
          if (path === "/environment/start-session" && request.method === "POST") {
            const input = await request.json();
            if (!state.environment) {
              state.environment = {
                ownerId,
                generation: input.newGeneration,
                status: "dispatching",
                slot: `slot-${ownerId}`,
              };
            }
            const generation = state.environment.status === "closing"
              ? state.environment.replacementGeneration ?? input.newGeneration
              : state.environment.generation;
            if (state.environment.status === "closing" && !state.environment.replacementGeneration) {
              state.environment.replacementGeneration = generation;
            }
            const created = await handleSessionRequest(
              state.storage,
              new Request("https://environment/sessions", {
                method: "POST",
                body: JSON.stringify({ ...input.session, generation }),
              }),
            );
            const body = await created.json();
            return Response.json({
              environment: state.environment,
              dispatch: state.environment.status === "dispatching" && !state.environment.runId,
              ...body,
            }, { status: created.status });
          }
          if (path === "/environment/dispatch" && request.method === "POST") {
            const input = await request.json();
            if (!state.environment || state.environment.generation !== input.generation) {
              return Response.json({ error: "generation mismatch" }, { status: 409 });
            }
            state.environment = {
              ...state.environment,
              status: "starting",
              runId: input.runId,
              runUrl: input.runUrl,
            };
            return Response.json({ environment: state.environment, cancel: false });
          }
          if (path === "/environment/dispatch-failed" && request.method === "POST") {
            state.environment = { ...state.environment, status: "offline" };
            return Response.json(state.environment);
          }
          if (path === "/environment/dispatch-unknown" && request.method === "POST") {
            state.environment = { ...state.environment, dispatchOutcome: "unknown" };
            return Response.json(state.environment);
          }
          if (path === "/sessions" || path.startsWith("/sessions/")) {
            const action = request.method === "POST"
              ? await request.clone().json().catch(() => undefined)
              : undefined;
            if (request.method === "POST" && path === "/sessions" &&
                (!state.environment || action?.generation !== state.environment.generation)) {
              return Response.json({ error: "Environment generation is not active" }, { status: 409 });
            }
            if (!channelAllowsSessionAction(state.environment, action)) {
              return Response.json({ error: "Environment channel is disconnected" }, { status: 409 });
            }
            return handleSessionRequest(state.storage, request);
          }
          return Response.json({ error: "not found" }, { status: 404 });
        },
      };
    },
  };
  return {
    env: {
      ENVIRONMENTS: binding,
      TASK_CONTROL_PLANE_URL: "https://runner.example",
      ENVIRONMENT_SESSION_SECRET: "test-session-secret",
    },
    environment: (ownerId) => owner(ownerId).environment,
    setEnvironment: (ownerId, environment) => { owner(ownerId).environment = environment; },
    storage: (ownerId) => owner(ownerId).storage,
  };
}

function fakeStorage() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? structuredClone(values.get(key)) : undefined;
    },
    async put(key, value) {
      if (typeof key === "object") {
        for (const [itemKey, itemValue] of Object.entries(key)) {
          values.set(itemKey, structuredClone(itemValue));
        }
      } else {
        values.set(key, structuredClone(value));
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    async list({ prefix = "", startAfter = "", limit = 1_000 } = {}) {
      return new Map([...values]
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => [key, structuredClone(value)]));
    },
    async transaction(callback) {
      return callback(this);
    },
    async setAlarm() {},
  };
}
