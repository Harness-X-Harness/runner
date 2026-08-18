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
    ["badge", "status", "description", "actions", "primary", "run", "stop", "message"].map((id) => [
      id,
      new Element(),
    ]),
  );
  const outbound = [];
  const messageListeners = [];
  const timers = [];
  let openCalls = 0;
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
                status: "ready",
                environmentUrl: "https://runner.example/environment",
                runUrl: "https://github.com/example/runner/actions/runs/123",
              },
            },
          }),
        );
      }
      if (message.method === "tools/call") {
        if (message.params.name === "open_environment") openCalls += 1;
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
              : openCalls === 1
                ? { error: { code: -32603, message: "temporary failure" } }
                : {
                  result: {
                    structuredContent: {
                      status: openCalls === 2 ? "starting" : "ready",
                      environmentUrl: "https://runner.example/environment",
                      runUrl: "https://github.com/example/runner/actions/runs/456",
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
    addEventListener(name, listener) {
      if (name === "message") messageListeners.push(listener);
    },
  };
  const document = {
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
  assert.equal(elements.get("primary").dataset.href, "https://runner.example/environment");
  assert.equal(elements.get("run").hidden, false);

  elements.get("primary").click();
  elements.get("run").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    outbound.filter(({ method }) => method === "ui/open-link").map(({ params }) => params.url),
    [
      "https://runner.example/environment",
      "https://github.com/example/runner/actions/runs/123",
    ],
  );

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
  });
  assert.equal(elements.get("status").textContent, "Closing");
  assert.equal(
    elements.get("description").textContent,
    "The runner is stopping. A replacement will start automatically.",
  );
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 10_000);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    outbound.filter(({ method }) => method === "tools/call").at(-1)?.params?.name,
    "open_environment",
  );
  assert.equal(elements.get("status").textContent, "Closing");
  assert.equal(elements.get("message").textContent, "Still waiting. Retrying…");
  assert.equal(timers.length, 2);

  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("status").textContent, "Starting");
  assert.equal(elements.get("run").dataset.href, "https://github.com/example/runner/actions/runs/456");
  assert.equal(timers.length, 3, "Starting must continue observing until the Environment is Ready");

  timers[2].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("status").textContent, "Ready");

  elements.get("stop").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("status").textContent, "Closing");
  assert.equal(elements.get("description").textContent, "The runner is stopping.");
  assert.equal(timers.length, 3, "an explicit Close must not schedule a replacement Open");
});
