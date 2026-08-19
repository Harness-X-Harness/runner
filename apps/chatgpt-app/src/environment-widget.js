import { WIDGET_BASE_STYLES, WIDGET_HOST_CONTEXT_SCRIPT } from "./widget-shell.js";

export const ENVIRONMENT_WIDGET_URI = "ui://environment/v5.html";
export const ENVIRONMENT_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export function environmentWidgetHtml(controlPlaneUrl) {
  const controlPlaneOrigin = new URL(controlPlaneUrl).origin;
  const originLiteral = JSON.stringify(controlPlaneOrigin);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
${WIDGET_BASE_STYLES}
    .badge[data-status="starting"] .dot { background: #b7791f; }
    .badge[data-status="ready"] .dot { background: #16825d; }
    .badge[data-status="closing"] .dot { background: #7567ad; }
  </style>
</head>
<body>
  <main class="card">
    <header>
      <div>
        <h1>Private development environment</h1>
        <p class="subtitle">Temporary, private, and ready for T3 or remote tools.</p>
      </div>
      <span id="badge" class="badge" data-status="starting"><span class="dot"></span><span id="status">Loading</span></span>
    </header>
    <p id="description" class="description">Loading the current environment state.</p>
    <div id="actions" class="actions" hidden>
      <button id="primary" class="primary" type="button" hidden></button>
      <button id="secondary" class="secondary" type="button" hidden></button>
    </div>
    <p id="message" class="message" role="status" aria-live="polite"></p>
  </main>
  <script>
    const controlPlaneOrigin = ${originLiteral};
    const badge = document.getElementById("badge");
    const statusLabel = document.getElementById("status");
    const description = document.getElementById("description");
    const actions = document.getElementById("actions");
    const primary = document.getElementById("primary");
    const secondary = document.getElementById("secondary");
    const message = document.getElementById("message");
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let current;
    let openRefresh;
    let openRequested = true;

${WIDGET_HOST_CONTEXT_SCRIPT}

    function safeUrl(value, kind) {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") return undefined;
        if (kind === "environment" && (url.origin !== controlPlaneOrigin || url.pathname !== "/environment")) return undefined;
        if (kind === "run" && url.origin !== "https://github.com") return undefined;
        return url.href;
      } catch {
        return undefined;
      }
    }

    function render(result) {
      current = result && typeof result === "object" ? result : {};
      const states = {
        starting: ["Starting", "Your runner and development tools are starting."],
        ready: ["Ready", "Your private environment is ready in T3."],
        closing: ["Closing", "The runner is stopping."],
        offline: ["Offline", "The temporary environment is closed."],
      };
      const state = states[current.status] ? current.status : "starting";
      badge.dataset.status = state;
      statusLabel.textContent = states[state][0];
      description.textContent = state === "closing" && openRequested
        ? "The runner is stopping. A replacement will start automatically."
        : states[state][1];

      const environmentUrl = safeUrl(current.environmentUrl, "environment");
      const runUrl = safeUrl(current.runUrl, "run");
      const proposals = [];
      if (state === "offline") proposals.push({ label: "Start environment", action: "open_environment" });
      if (state === "starting" && runUrl) proposals.push({ label: "View GitHub run", href: runUrl });
      if (state === "starting") proposals.push({ label: "Stop", action: "close_environment", intent: "danger" });
      if (state === "ready" && environmentUrl) proposals.push({ label: "Open T3", href: environmentUrl });
      if (state === "ready") proposals.push({ label: "Stop", action: "close_environment", intent: "danger" });
      if (state === "closing" && runUrl) proposals.push({ label: "View GitHub run", href: runUrl });
      renderActions(proposals.slice(0, 2));
      message.textContent = "";
      scheduleOpenRefresh(state);
    }

    function renderActions(proposals) {
      const buttons = [primary, secondary];
      buttons.forEach((button, index) => {
        const proposal = proposals[index];
        button.hidden = !proposal;
        button.textContent = proposal?.label || "";
        button.dataset.action = proposal?.action || "";
        button.dataset.href = proposal?.href || "";
        button.dataset.intent = proposal?.intent || "";
      });
      actions.hidden = proposals.length === 0;
    }

    function scheduleOpenRefresh(state) {
      if (openRefresh !== undefined) clearTimeout(openRefresh);
      openRefresh = undefined;
      if (!openRequested || (state !== "closing" && state !== "starting")) return;
      openRefresh = setTimeout(() => {
        openRefresh = undefined;
        callTool("open_environment");
      }, 10_000);
    }

    function request(method, params) {
      const id = nextRequestId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => pendingRequests.set(id, { resolve, reject }));
    }

    function notify(method) {
      window.parent.postMessage({ jsonrpc: "2.0", method }, "*");
    }

    async function callTool(name) {
      openRequested = name === "open_environment";
      setBusy(true);
      let failed = false;
      let rendered = false;
      try {
        const result = await request("tools/call", { name, arguments: {} });
        if (result?.structuredContent) {
          render(result.structuredContent);
          rendered = true;
        }
      } catch {
        failed = true;
      } finally {
        setBusy(false);
      }
      const openPending = openRequested && (current?.status === "closing" || current?.status === "starting");
      if (failed) message.textContent = openPending ? "Still waiting. Retrying…" : "Could not update the environment.";
      if (!rendered && openPending) scheduleOpenRefresh(current.status);
    }

    async function openLink(href) {
      if (href) await request("ui/open-link", { url: href });
    }

    function setBusy(busy) {
      primary.disabled = busy;
      secondary.disabled = busy;
      message.textContent = busy ? "Updating environment…" : "";
    }

    function perform(button) {
      if (button.dataset.action) callTool(button.dataset.action);
      else openLink(button.dataset.href);
    }

    window.addEventListener("message", event => {
      if (event.source !== window.parent) return;
      const incoming = event.data;
      if (!incoming || incoming.jsonrpc !== "2.0") return;
      if (incoming.id !== undefined && pendingRequests.has(incoming.id)) {
        const pending = pendingRequests.get(incoming.id);
        pendingRequests.delete(incoming.id);
        if (incoming.error) pending.reject(incoming.error);
        else pending.resolve(incoming.result);
        return;
      }
      if (incoming.method === "ui/notifications/tool-result") render(incoming.params?.structuredContent);
    }, { passive: true });

    primary.addEventListener("click", () => perform(primary));
    secondary.addEventListener("click", () => perform(secondary));

    async function connect() {
      await request("ui/initialize", {
        appCapabilities: {},
        appInfo: { name: "Harness X Harness Environment", version: "1.0.0" },
        protocolVersion: "2026-01-26",
      });
      notify("ui/notifications/initialized");
    }

    connect();
  </script>
</body>
</html>`;
}
