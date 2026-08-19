import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { sessionWidgetHtml } from "../apps/chatgpt-app/src/session-widget.js";

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.textContent = "";
    this.type = "";
    this.value = "";
    this.checked = false;
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { return this.listeners.get("click")?.(); }
  appendChild(child) {
    this.children.push(child);
    if (!this.value && child.value) this.value = child.value;
    return child;
  }
  replaceChildren(...children) {
    this.children = [...children];
    this.value = children[0]?.value ?? "";
  }
}

function script(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match);
  return match[1];
}

test("Session Widget streams ordered events and invokes every exact Session control", async () => {
  const ids = ["title","badge","phase","executor","channel","controller","cwd","environment","timeline","requestPanel","requestTitle","requestDetail","requestChoices","requestFields","respond","queuePanel","queuedTurns","cancelQueued","composer","steer","queue","interrupt","takeover","stop","openEnvironment","viewRun","message"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const outbound = [];
  const listeners = [];
  const toolCalls = [];
  const session = {
    sessionId: "session-1",
    executor: "codex",
    phase: "running",
    channelState: "connected",
    controller: { clientName: "ChatGPT", currentGrant: true },
    workingDirectory: "/home/runner",
    activeTurnId: "turn-active",
    queuedTurns: [{ turnId: "turn-queued", createdAt: "2026-08-19T00:00:00.000Z" }],
    pendingRequests: [{ requestId: "request-1", kind: "permission" }],
    latestCursor: 4,
    environment: {
      status: "ready",
      entryUrl: "https://runner.example/environment",
      runUrl: "https://github.com/example/runner/actions/runs/1",
    },
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  const parent = {
    postMessage(message) {
      outbound.push(message);
      if (message.method === "ui/initialize") {
        queueMicrotask(() => deliver({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
      if (message.method === "ui/notifications/initialized") {
        queueMicrotask(() => deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            structuredContent: session,
            _meta: {
              sessionStream: {
                url: "https://runner.example/session-stream/session-1",
                token: "private-capability",
              },
            },
          },
        }));
      }
      if (message.method === "tools/call") {
        toolCalls.push(message.params);
        queueMicrotask(() => deliver({
          jsonrpc: "2.0",
          id: message.id,
          result: { structuredContent: session },
        }));
      }
      if (message.method === "ui/open-link") {
        queueMicrotask(() => deliver({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
    },
  };
  const deliver = (data) => listeners.forEach((listener) => listener({ source: parent, data }));
  const payload = new TextEncoder().encode(`${JSON.stringify({
    type: "snapshot",
    session,
    events: [
      { cursor: 1, sessionId: "session-1", type: "user_message", createdAt: session.createdAt, data: { turnId: "turn-active", delivery: "steer", text: "Inspect" } },
      { cursor: 2, sessionId: "session-1", type: "agent_message_chunk", createdAt: session.createdAt, data: { turnId: "turn-active", text: "Working " } },
      { cursor: 2, sessionId: "session-1", type: "agent_message_chunk", createdAt: session.createdAt, data: { turnId: "turn-active", text: "duplicate" } },
      { cursor: 3, sessionId: "session-1", type: "agent_message_chunk", createdAt: session.createdAt, data: { turnId: "turn-active", text: "answer" } },
      { cursor: 4, sessionId: "session-1", type: "request", createdAt: session.createdAt, data: { requestId: "request-1", state: "open", kind: "permission", title: "Allow command", choices: [{ choiceId: "allow-once", label: "Allow once" }] } },
    ],
    nextCursor: 4,
    hasMore: false,
  })}\n`);
  let reads = 0;
  const fetchCalls = [];
  const fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => reads++ === 0
            ? { done: false, value: payload }
            : new Promise(() => {}),
        }),
      },
    };
  };

  vm.runInNewContext(script(sessionWidgetHtml("https://runner.example")), {
    console,
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
    },
    fetch,
    Map,
    Object,
    Promise,
    queueMicrotask,
    setTimeout,
    TextDecoder,
    URL,
    window: {
      parent,
      addEventListener(name, listener) { if (name === "message") listeners.push(listener); },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer private-capability");
  assert.match(fetchCalls[0].url, /after=0/);
  assert.match(elements.get("timeline").textContent, /You · steer/);
  assert.match(elements.get("timeline").textContent, /Agent · Working answer/);
  assert.doesNotMatch(elements.get("timeline").textContent, /duplicate/);
  assert.equal(elements.get("requestPanel").hidden, false);
  assert.equal(elements.get("requestChoices").children[0].value, "allow-once");

  elements.get("composer").value = "Steer text";
  await elements.get("steer").click();
  elements.get("composer").value = "Queue text";
  await elements.get("queue").click();
  await elements.get("cancelQueued").click();
  await elements.get("interrupt").click();
  await elements.get("respond").click();
  await elements.get("stop").click();
  await new Promise((resolve) => setImmediate(resolve));

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: {
        session: {
          ...session,
          pendingRequests: [{ requestId: "request-2", kind: "input" }],
        },
        events: [{
          cursor: 5,
          sessionId: "session-1",
          type: "request",
          createdAt: session.createdAt,
          data: {
            requestId: "request-2",
            state: "open",
            kind: "input",
            title: "Choose branch",
            inputSchema: {
              type: "object",
              properties: { branch: { type: "string", title: "Branch" } },
              required: ["branch"],
            },
          },
        }],
      },
    },
  });
  elements.get("requestFields").children[0].children[0].value = "main";
  await elements.get("respond").click();

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { ...session, controller: { clientName: "VS Code", currentGrant: false } } },
  });
  assert.equal(elements.get("takeover").hidden, false);
  await elements.get("takeover").click();

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { ...session, channelState: "disconnected" } },
  });
  assert.equal(elements.get("steer").disabled, true);
  assert.equal(elements.get("queue").disabled, false);

  await elements.get("openEnvironment").click();
  await elements.get("viewRun").click();
  const plainToolCalls = JSON.parse(JSON.stringify(toolCalls));
  assert.deepEqual(
    plainToolCalls.filter(({ name }) => name === "send_turn").map(({ arguments: args }) => args),
    [
      { sessionId: "session-1", text: "Steer text", delivery: "steer" },
      { sessionId: "session-1", text: "Queue text", delivery: "queue" },
    ],
  );
  const byName = Object.fromEntries(plainToolCalls.map((call) => [call.name, call.arguments]));
  assert.deepEqual(byName.cancel_queued_turn, { sessionId: "session-1", turnId: "turn-queued" });
  assert.deepEqual(byName.interrupt_turn, { sessionId: "session-1", activeTurnId: "turn-active" });
  assert.deepEqual(
    plainToolCalls.filter(({ name }) => name === "respond_to_session").map(({ arguments: args }) => args),
    [
      { sessionId: "session-1", requestId: "request-1", choiceId: "allow-once" },
      { sessionId: "session-1", requestId: "request-2", values: { branch: "main" } },
    ],
  );
  assert.deepEqual(byName.stop_session, { sessionId: "session-1" });
  assert.deepEqual(byName.take_over_session, { sessionId: "session-1" });
  assert.deepEqual(
    outbound.filter(({ method }) => method === "ui/open-link").map(({ params }) => params.url),
    [
      "https://runner.example/environment",
      "https://github.com/example/runner/actions/runs/1",
    ],
  );
  assert.equal(sessionWidgetHtml("https://runner.example").includes("private-capability"), false);
});

test("Session Widget accepts early initialization data and refreshes an expired stream capability", async () => {
  const ids = ["title","badge","phase","executor","channel","controller","cwd","environment","timeline","requestPanel","requestTitle","requestDetail","requestChoices","requestFields","respond","queuePanel","queuedTurns","cancelQueued","composer","steer","queue","interrupt","takeover","stop","openEnvironment","viewRun","message"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const listeners = [];
  const toolCalls = [];
  const base = {
    sessionId: "session-refresh",
    executor: "grok",
    phase: "idle",
    channelState: "connected",
    controller: { clientName: "ChatGPT", currentGrant: true },
    workingDirectory: "/home/runner",
    queuedTurns: [],
    pendingRequests: [],
    latestCursor: 0,
    environment: { status: "ready", entryUrl: "https://runner.example/environment" },
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  const parent = {
    postMessage(message) {
      if (message.method === "ui/initialize") {
        queueMicrotask(() => deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            structuredContent: base,
            _meta: { sessionStream: { url: "https://runner.example/session-stream/session-refresh", token: "expired" } },
          },
        }));
        queueMicrotask(() => deliver({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
      if (message.method === "tools/call") {
        toolCalls.push(message.params);
        queueMicrotask(() => deliver({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              session: { ...base, phase: "terminal", terminalReason: "stopped" },
              events: [],
              nextCursor: 0,
              hasMore: false,
            },
            _meta: { sessionStream: { url: "https://runner.example/session-stream/session-refresh", token: "fresh" } },
          },
        }));
      }
    },
  };
  const deliver = (data) => listeners.forEach((listener) => listener({ source: parent, data }));
  const fetchTokens = [];
  vm.runInNewContext(script(sessionWidgetHtml("https://runner.example")), {
    console,
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
    },
    fetch: async (_url, options) => {
      fetchTokens.push(options.headers.authorization);
      return { ok: false, status: 401 };
    },
    Map,
    Object,
    Promise,
    queueMicrotask,
    setTimeout,
    TextDecoder,
    URL,
    window: {
      parent,
      addEventListener(name, listener) { if (name === "message") listeners.push(listener); },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fetchTokens, ["Bearer expired"]);
  assert.deepEqual(JSON.parse(JSON.stringify(toolCalls)), [{
    name: "read_session",
    arguments: { sessionId: "session-refresh", afterCursor: 0, limit: 100 },
  }]);
  assert.equal(elements.get("phase").textContent, "terminal");
});

test("Session Widget does not let a delayed tool response replace a newer stream snapshot", async () => {
  const ids = ["title","badge","phase","executor","channel","controller","cwd","environment","timeline","requestPanel","requestTitle","requestDetail","requestChoices","requestFields","respond","queuePanel","queuedTurns","cancelQueued","composer","steer","queue","interrupt","takeover","stop","openEnvironment","viewRun","message"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const listeners = [];
  let pendingToolCall;
  let releaseStream;
  const base = {
    sessionId: "session-race",
    executor: "codex",
    phase: "idle",
    channelState: "connected",
    controller: { clientName: "VS Code", currentGrant: false },
    workingDirectory: "/home/runner",
    queuedTurns: [],
    pendingRequests: [],
    latestCursor: 9,
    environment: { status: "ready", entryUrl: "https://runner.example/environment" },
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:09.000Z",
  };
  const parent = {
    postMessage(message) {
      if (message.method === "ui/initialize") {
        queueMicrotask(() => deliver({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
      if (message.method === "ui/notifications/initialized") {
        queueMicrotask(() => deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            structuredContent: base,
            _meta: {
              sessionStream: {
                url: "https://runner.example/session-stream/session-race",
                token: "private-capability",
              },
            },
          },
        }));
      }
      if (message.method === "tools/call") pendingToolCall = message;
    },
  };
  const deliver = (data) => listeners.forEach((listener) => listener({ source: parent, data }));
  let streamReads = 0;
  const streamPayload = new TextEncoder().encode(`${JSON.stringify({
    type: "snapshot",
    session: {
      ...base,
      controller: { clientName: "Cursor 11 Client", currentGrant: false },
      latestCursor: 11,
      updatedAt: "2026-08-19T00:00:11.000Z",
    },
    events: [{
      cursor: 11,
      sessionId: "session-race",
      type: "status",
      createdAt: "2026-08-19T00:00:11.000Z",
      data: { controllerName: "Cursor 11 Client" },
    }],
    nextCursor: 11,
    hasMore: false,
  })}\n`);
  const firstStreamRead = new Promise((resolve) => { releaseStream = resolve; });
  vm.runInNewContext(script(sessionWidgetHtml("https://runner.example")), {
    console,
    document: {
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => streamReads++ === 0
            ? firstStreamRead
            : new Promise(() => {}),
        }),
      },
    }),
    Map,
    Object,
    Promise,
    queueMicrotask,
    setTimeout,
    TextDecoder,
    URL,
    window: {
      parent,
      addEventListener(name, listener) { if (name === "message") listeners.push(listener); },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const takeover = elements.get("takeover").click();
  assert.equal(pendingToolCall.params.name, "take_over_session");
  releaseStream({ done: false, value: streamPayload });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("controller").textContent, "Cursor 11 Client");

  deliver({
    jsonrpc: "2.0",
    id: pendingToolCall.id,
    result: {
      structuredContent: {
        ...base,
        controller: { clientName: "Delayed Cursor 10 Client", currentGrant: true },
        latestCursor: 10,
        updatedAt: "2026-08-19T00:00:10.000Z",
      },
    },
  });
  await takeover;

  assert.equal(elements.get("controller").textContent, "Cursor 11 Client");
  assert.equal(elements.get("takeover").hidden, false);
});
