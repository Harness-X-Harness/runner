import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { environmentWidgetHtml } from "../apps/chatgpt-app/src/environment-widget.js";

class Element {
  constructor() {
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  click() {
    this.listeners.get("click")?.();
  }
}

function widgetScript(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "widget script is present");
  return match[1];
}

test("Environment Widget converges an Open intent to Ready and explicit Close stops it", async () => {
  const elements = new Map(
    ["badge", "status", "description", "actions", "primary", "secondary", "message"].map((id) => [
      id,
      new Element(),
    ]),
  );
  const outbound = [];
  const messageListeners = [];
  const hostListeners = new Map();
  const timers = [];
  let observationCalls = 0;
  const parent = {
    postMessage(message) {
      outbound.push(message);
      if (message.method === "ui/initialize") {
        queueMicrotask(() =>
          deliver({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2026-01-26",
              hostCapabilities: { openLinks: {} },
              hostInfo: { name: "test-host", version: "1.0.0" },
            },
          }),
        );
      }
      if (message.method === "ui/notifications/initialized") {
        queueMicrotask(() =>
          deliver({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              structuredContent: {
                status: "closing",
                environmentUrl: "https://runner.example/environment",
                runUrl: "https://github.com/example/runner/actions/runs/123",
              },
            },
          }),
        );
      }
      if (message.method === "tools/call") {
        const observing = message.params.name === "open_environment" &&
          message.params.arguments.operation === "observe";
        if (observing) observationCalls += 1;
        queueMicrotask(() =>
          deliver({
            jsonrpc: "2.0",
            id: message.id,
            ...(message.params.name === "close_environment"
              ? {
                  result: {
                    structuredContent: {
                      status: "closing",
                      environmentUrl: "https://runner.example/environment",
                      runUrl: "https://github.com/example/runner/actions/runs/456",
                    },
                  },
                }
              : observing && observationCalls === 1
                ? { error: { code: -32603, message: "temporary failure" } }
                : {
                  result: {
                    structuredContent: {
                      status: observing
                        ? new Set([2, 4]).has(observationCalls) ? "offline" : "ready"
                        : "starting",
                      ...(observing && observationCalls === 2 ? {} : {
                        environmentUrl: "https://runner.example/environment",
                        runUrl: "https://github.com/example/runner/actions/runs/456",
                      }),
                    },
                  },
                }),
          }),
        );
      }
    },
  };
  const deliver = (data) => {
    for (const listener of messageListeners) listener({ source: parent, data });
  };
  const window = {
    parent,
    openai: { theme: "dark" },
    addEventListener(name, listener) {
      if (name === "message") messageListeners.push(listener);
      else hostListeners.set(name, listener);
    },
  };
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      return elements.get(id);
    },
  };

  vm.runInNewContext(widgetScript(environmentWidgetHtml("https://runner.example")), {
    console,
    document,
    Map,
    Promise,
    queueMicrotask,
    URL,
    window,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cancelled = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(outbound[0]?.method, "ui/initialize");
  assert.ok(outbound.some(({ method }) => method === "ui/notifications/initialized"));
  assert.equal(document.documentElement.dataset.theme, "dark");
  hostListeners.get("openai:set_globals")({ detail: { globals: { theme: "light" } } });
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(elements.get("status").textContent, "Closing");
  assert.equal(
    elements.get("description").textContent,
    "The runner is stopping. A replacement will start automatically.",
  );
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 10_000);
  assert.equal(elements.get("primary").dataset.href, "https://github.com/example/runner/actions/runs/123");
  assert.equal(elements.get("secondary").hidden, true);
  elements.get("primary").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    outbound.filter(({ method }) => method === "ui/open-link").at(-1)?.params.url,
    "https://github.com/example/runner/actions/runs/123",
  );

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    outbound.filter(({ method }) => method === "tools/call").at(-1)?.params?.name,
    "open_environment",
  );
  assert.equal(
    JSON.stringify(outbound.filter(({ method }) => method === "tools/call").at(-1)?.params?.arguments),
    JSON.stringify({ operation: "observe" }),
  );
  assert.equal(elements.get("status").textContent, "Closing");
  assert.equal(elements.get("message").textContent, "Still waiting. Retrying…");
  assert.equal(timers.length, 2);

  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("status").textContent, "Starting");
  assert.equal(
    JSON.stringify(outbound.filter(({ method }) => method === "tools/call").slice(-2).map(({ params }) => params.arguments)),
    JSON.stringify([{ operation: "observe" }, { operation: "open" }]),
    "one terminal observation may start exactly one replacement",
  );
  assert.equal(elements.get("primary").dataset.href, "https://github.com/example/runner/actions/runs/456");
  assert.equal(elements.get("secondary").dataset.action, "close_environment");
  assert.equal(timers.length, 3, "Starting must continue observing until the Environment is Ready");

  timers[2].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("status").textContent, "Ready");

  elements.get("secondary").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("status").textContent, "Closing");
  assert.equal(elements.get("description").textContent, "The runner is stopping.");
  assert.equal(timers.length, 3, "an explicit Close must not schedule a replacement Open");

  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { status: "offline" } },
  });
  elements.get("primary").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("status").textContent, "Starting");
  assert.equal(timers.length, 4);

  timers[3].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("status").textContent, "Offline");
  assert.equal(timers.length, 4, "a failed initial Starting run must stop observing");
  assert.equal(
    outbound.filter(({ method, params }) =>
      method === "tools/call" && params.name === "open_environment" &&
      params.arguments.operation === "open").length,
    2,
    "one user Start and one Closing replacement are the only mutating Open calls",
  );
});
