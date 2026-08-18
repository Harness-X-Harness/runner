export const ENVIRONMENT_WIDGET_URI = "ui://environment/v4.html";
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
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: CanvasText; background: transparent; }
    .card { padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 18px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .eyebrow { margin: 0 0 5px; color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 11px; font-weight: 700; letter-spacing: .12em; }
    h1 { margin: 0; font-size: 18px; line-height: 1.25; letter-spacing: -.01em; }
    .badge { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; padding: 5px 10px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, transparent); font-size: 12px; font-weight: 650; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b8b8b; }
    .badge[data-status="starting"] .dot { background: #e0a21a; box-shadow: 0 0 0 4px color-mix(in srgb, #e0a21a 18%, transparent); }
    .badge[data-status="ready"] .dot { background: #22a06b; box-shadow: 0 0 0 4px color-mix(in srgb, #22a06b 18%, transparent); }
    .badge[data-status="closing"] .dot { background: #7b61d1; box-shadow: 0 0 0 4px color-mix(in srgb, #7b61d1 18%, transparent); }
    .description { margin: 14px 0 18px; color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 14px; line-height: 1.45; }
    .actions { display: flex; flex-wrap: wrap; gap: 9px; }
    button { min-height: 38px; padding: 8px 13px; border: 0; border-radius: 10px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .55; }
    .primary { color: #fff; background: #111; }
    .secondary { color: CanvasText; background: color-mix(in srgb, CanvasText 9%, transparent); }
    .danger { margin-left: auto; color: #b42318; background: color-mix(in srgb, #d92d20 10%, transparent); }
    .message { min-height: 18px; margin: 11px 0 0; color: color-mix(in srgb, CanvasText 60%, transparent); font-size: 12px; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) { .primary { color: #111; background: #f3f3f3; } .danger { color: #ff8a80; } }
    @media (max-width: 440px) { header { display: block; } .badge { margin-top: 12px; } .danger { margin-left: 0; } }
  </style>
</head>
<body>
  <main class="card" aria-live="polite">
    <header>
      <div>
        <p class="eyebrow">HARNESS X HARNESS</p>
        <h1>Private Development Environment</h1>
      </div>
      <span id="badge" class="badge" data-status="starting"><span class="dot"></span><span id="status">Loading</span></span>
    </header>
    <p id="description" class="description">Loading the current environment state.</p>
    <div id="actions" class="actions" hidden>
      <button id="primary" class="primary" type="button">Open environment</button>
      <button id="run" class="secondary" type="button" hidden>View GitHub run</button>
      <button id="stop" class="danger" type="button">Stop environment</button>
    </div>
    <p id="message" class="message" role="status"></p>
  </main>
  <script>
    const controlPlaneOrigin = ${originLiteral};
    const badge = document.getElementById("badge");
    const statusLabel = document.getElementById("status");
    const description = document.getElementById("description");
    const actions = document.getElementById("actions");
    const primary = document.getElementById("primary");
    const run = document.getElementById("run");
    const stop = document.getElementById("stop");
    const message = document.getElementById("message");
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let current;
    let openRefresh;
    let openRequested = true;

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
        starting: ["Starting", "Your temporary runner and development tools are starting."],
        ready: ["Ready", "Your private environment is ready. Open it to continue in T3."],
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
      actions.hidden = false;
      primary.hidden = state === "closing";
      primary.textContent = state === "offline" ? "Start new environment" : state === "ready" ? "Open T3" : "Open environment";
      primary.dataset.href = environmentUrl || "";
      run.hidden = !runUrl;
      run.dataset.href = runUrl || "";
      stop.hidden = state === "closing" || state === "offline";
      message.textContent = "";
      scheduleOpenRefresh(state);
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
      if (!href) return;
      await request("ui/open-link", { url: href });
    }

    function setBusy(busy) {
      primary.disabled = busy;
      run.disabled = busy;
      stop.disabled = busy;
      message.textContent = busy ? "Updating environment…" : "";
    }

    window.addEventListener("message", (event) => {
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
      if (incoming.method === "ui/notifications/tool-result") {
        render(incoming.params?.structuredContent);
      }
    }, { passive: true });

    primary.addEventListener("click", () => {
      if (current?.status === "offline") callTool("open_environment");
      else openLink(primary.dataset.href);
    });
    run.addEventListener("click", () => openLink(run.dataset.href));
    stop.addEventListener("click", () => callTool("close_environment"));

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
