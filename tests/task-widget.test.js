import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { taskWidgetHtml } from "../apps/chatgpt-app/src/task-widget.js";

class Element {
  constructor() {
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.scrollHeight = 10;
    this.scrollTop = 0;
    this.textContent = "";
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { return this.listeners.get("click")?.(); }
}

function widgetScript(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match);
  return match[1];
}

test("Task Widget consumes its private NDJSON stream and renders the terminal result", async () => {
  const ids = ["title", "badge", "status", "executor", "mode", "description", "output", "notice", "authorize", "run", "pullRequest", "cancel", "message"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const outbound = [];
  const listeners = [];
  const requests = [];
  const parent = {
    postMessage(message) {
      outbound.push(message);
      if (message.method === "ui/initialize") queueMicrotask(() => deliver({ jsonrpc: "2.0", id: message.id, result: {} }));
      if (message.method === "ui/notifications/initialized") queueMicrotask(() => deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          structuredContent: { taskId: "task_123", repo: "owner/repo", executor: "grok", mode: "analyze", status: "running" },
          _meta: { taskStream: { url: "https://runner.example/task-stream/task_123", token: "private-token" } },
        },
      }));
    },
  };
  const deliver = (data) => listeners.forEach((listener) => listener({ source: parent, data }));
  const payload = [
    JSON.stringify({
      type: "snapshot",
      task: { id: "task_123", repo: "owner/repo", executor: "grok", mode: "analyze", status: "running" },
      events: [
        { seq: 1, type: "message_delta", data: { text: "Live " } },
        { seq: 2, type: "message_delta", data: { text: "answer" } },
        { seq: 3, type: "status", data: { id: "task_123", repo: "owner/repo", executor: "grok", mode: "analyze", status: "completed", result: { summary: "Authoritative final answer" } } },
      ],
      truncated: false,
    }),
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(payload);
  const fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    let sent = false;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }) },
    };
  };

  vm.runInNewContext(widgetScript(taskWidgetHtml("https://runner.example")), {
    console,
    document: { getElementById: (id) => elements.get(id) },
    fetch,
    Map,
    Promise,
    queueMicrotask,
    setTimeout,
    TextDecoder,
    URL,
    window: { parent, addEventListener: (name, listener) => { if (name === "message") listeners.push(listener); } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.authorization, "Bearer private-token");
  assert.match(requests[0].url, /after=0/);
  assert.equal(elements.get("status").textContent, "completed");
  assert.equal(elements.get("output").textContent, "Authoritative final answer");
  assert.equal(elements.get("cancel").hidden, true);
  assert.ok(outbound.some(({ method }) => method === "ui/notifications/initialized"));
});
