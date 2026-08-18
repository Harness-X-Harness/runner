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

test("Environment Widget connects before receiving results and opens both safe links", async () => {
  const elements = new Map(
    ["badge", "status", "description", "actions", "primary", "run", "stop", "message"].map((id) => [
      id,
      new Element(),
    ]),
  );
  const outbound = [];
  const messageListeners = [];
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
                status: "starting",
                environmentUrl: "https://runner.example/environment",
                runUrl: "https://github.com/example/runner/actions/runs/123",
              },
            },
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
});
