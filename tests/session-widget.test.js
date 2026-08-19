import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { sessionWidgetHtml } from "../apps/chatgpt-app/src/session-widget.js";

const IDS = [
  "title",
  "subtitle",
  "badge",
  "phase",
  "summary",
  "timeline",
  "requestPanel",
  "requestTitle",
  "requestDetail",
  "requestChoices",
  "requestFields",
  "queueSummary",
  "actions",
  "primary",
  "secondary",
  "message",
];

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
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

function fixtureSession(fields = {}) {
  return {
    sessionId: "session-1",
    executor: "codex",
    phase: "running",
    channelState: "connected",
    controller: { clientName: "ChatGPT", currentGrant: true },
    allowedActions: [
      "send_turn",
      "interrupt_turn",
      "respond_to_session",
      "cancel_queued_turn",
      "stop_session",
    ],
    allowedTurnDeliveries: ["steer", "queue"],
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
    ...fields,
  };
}

test("Session Widget keeps one focused decision, streams recent output, and follows host theme", async () => {
  const elements = new Map(IDS.map((id) => [id, new Element()]));
  const outbound = [];
  const messageListeners = [];
  const hostListeners = new Map();
  const toolCalls = [];
  const session = fixtureSession();
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
  const deliver = (data) => messageListeners.forEach((listener) => listener({ source: parent, data }));
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
  const document = {
    documentElement: { dataset: {} },
    getElementById: (id) => elements.get(id),
    createElement: () => new Element(),
  };
  const window = {
    parent,
    openai: { theme: "dark" },
    addEventListener(name, listener) {
      if (name === "message") messageListeners.push(listener);
      else hostListeners.set(name, listener);
    },
  };

  vm.runInNewContext(script(sessionWidgetHtml("https://runner.example")), {
    console,
    document,
    fetch: async (url, options) => {
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
    },
    Map,
    Object,
    Promise,
    queueMicrotask,
    Set,
    setTimeout,
    TextDecoder,
    URL,
    window,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer private-capability");
  assert.match(fetchCalls[0].url, /after=0/);
  assert.match(elements.get("timeline").textContent, /You · Inspect/);
  assert.match(elements.get("timeline").textContent, /Agent · Working answer/);
  assert.doesNotMatch(elements.get("timeline").textContent, /duplicate/);
  assert.equal(elements.get("requestPanel").hidden, false);
  assert.equal(elements.get("requestChoices").children[0].value, "allow-once");
  assert.equal(elements.get("primary").dataset.action, "respond_to_session");
  assert.equal(elements.get("secondary").dataset.action, "stop_session");
  assert.equal(document.documentElement.dataset.theme, "dark");
  hostListeners.get("openai:set_globals")({ detail: { globals: { theme: "light" } } });
  assert.equal(document.documentElement.dataset.theme, "light");

  elements.get("primary").click();
  await new Promise((resolve) => setImmediate(resolve));

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: {
        session: fixtureSession({
          pendingRequests: [{ requestId: "request-2", kind: "input" }],
          latestCursor: 5,
        }),
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
  elements.get("primary").click();
  await new Promise((resolve) => setImmediate(resolve));

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: fixtureSession({
        pendingRequests: [],
        allowedActions: ["interrupt_turn", "stop_session"],
        latestCursor: 6,
      }),
    },
  });
  assert.equal(elements.get("primary").dataset.action, "interrupt_turn");
  elements.get("primary").click();
  await new Promise((resolve) => setImmediate(resolve));
  elements.get("secondary").click();
  await new Promise((resolve) => setImmediate(resolve));

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: fixtureSession({
        controller: { clientName: "VS Code", currentGrant: false },
        allowedActions: ["take_over_session"],
        pendingRequests: [],
        latestCursor: 7,
      }),
    },
  });
  assert.equal(elements.get("primary").dataset.action, "take_over_session");
  elements.get("primary").click();
  await new Promise((resolve) => setImmediate(resolve));

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: fixtureSession({
        phase: "terminal",
        terminalReason: "stopped",
        allowedActions: [],
        pendingRequests: [],
        latestCursor: 8,
      }),
    },
  });
  assert.equal(elements.get("primary").dataset.href, "https://runner.example/environment");
  assert.equal(elements.get("secondary").dataset.href, "https://github.com/example/runner/actions/runs/1");
  elements.get("primary").click();
  elements.get("secondary").click();
  await new Promise((resolve) => setImmediate(resolve));

  const plainToolCalls = JSON.parse(JSON.stringify(toolCalls));
  assert.deepEqual(
    plainToolCalls.filter(({ name }) => name === "respond_to_session").map(({ arguments: args }) => args),
    [
      { sessionId: "session-1", requestId: "request-1", choiceId: "allow-once" },
      { sessionId: "session-1", requestId: "request-2", values: { branch: "main" } },
    ],
  );
  const byName = Object.fromEntries(plainToolCalls.map((call) => [call.name, call.arguments]));
  assert.deepEqual(byName.interrupt_turn, { sessionId: "session-1", activeTurnId: "turn-active" });
  assert.deepEqual(byName.stop_session, { sessionId: "session-1" });
  assert.deepEqual(byName.take_over_session, { sessionId: "session-1" });
  assert.equal(byName.send_turn, undefined);
  assert.equal(byName.cancel_queued_turn, undefined);
  assert.deepEqual(
    outbound.filter(({ method }) => method === "ui/open-link").map(({ params }) => params.url),
    [
      "https://runner.example/environment",
      "https://github.com/example/runner/actions/runs/1",
    ],
  );
  const html = sessionWidgetHtml("https://runner.example");
  assert.doesNotMatch(html, /<textarea|overflow:\s*auto/);
  assert.equal(html.includes("private-capability"), false);
});

test("Session Widget accepts early initialization data and refreshes an expired stream capability", async () => {
  const elements = new Map(IDS.map((id) => [id, new Element()]));
  const listeners = [];
  const toolCalls = [];
  const base = fixtureSession({
    sessionId: "session-refresh",
    executor: "grok",
    phase: "idle",
    allowedActions: ["send_turn", "stop_session"],
    activeTurnId: undefined,
    queuedTurns: [],
    pendingRequests: [],
    latestCursor: 0,
  });
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
              session: { ...base, phase: "terminal", terminalReason: "stopped", allowedActions: [] },
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
      documentElement: { dataset: {} },
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
    Set,
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
  assert.equal(elements.get("phase").textContent, "Ended");
});

test("Session Widget does not let a delayed tool response replace a newer stream snapshot", async () => {
  const elements = new Map(IDS.map((id) => [id, new Element()]));
  const listeners = [];
  let pendingToolCall;
  let releaseStream;
  const base = fixtureSession({
    sessionId: "session-race",
    phase: "idle",
    controller: { clientName: "VS Code", currentGrant: false },
    allowedActions: ["take_over_session"],
    activeTurnId: undefined,
    queuedTurns: [],
    pendingRequests: [],
    latestCursor: 9,
  });
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
      documentElement: { dataset: {} },
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
    Set,
    setTimeout,
    TextDecoder,
    URL,
    window: {
      parent,
      addEventListener(name, listener) { if (name === "message") listeners.push(listener); },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  elements.get("primary").click();
  assert.equal(pendingToolCall.params.name, "take_over_session");
  releaseStream({ done: false, value: streamPayload });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.get("summary").textContent, /Cursor 11 Client controls/);

  deliver({
    jsonrpc: "2.0",
    id: pendingToolCall.id,
    result: {
      structuredContent: {
        ...base,
        controller: { clientName: "Delayed Cursor 10 Client", currentGrant: true },
        allowedActions: [],
        latestCursor: 10,
        updatedAt: "2026-08-19T00:00:10.000Z",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.get("summary").textContent, /Cursor 11 Client controls/);
  assert.equal(elements.get("primary").dataset.action, "take_over_session");
});
