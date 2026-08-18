export const TASK_WIDGET_URI = "ui://task/v1.html";
export const TASK_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export function taskWidgetHtml(controlPlaneUrl) {
  const controlPlaneOrigin = new URL(controlPlaneUrl).origin;
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
    h1 { margin: 0; font-size: 18px; line-height: 1.25; overflow-wrap: anywhere; }
    .badge { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; padding: 5px 10px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, transparent); font-size: 12px; font-weight: 650; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b8b8b; }
    .badge[data-status="running"] .dot, .badge[data-status="testing"] .dot, .badge[data-status="committing"] .dot { background: #e0a21a; box-shadow: 0 0 0 4px color-mix(in srgb, #e0a21a 18%, transparent); }
    .badge[data-status="completed"] .dot { background: #22a06b; box-shadow: 0 0 0 4px color-mix(in srgb, #22a06b 18%, transparent); }
    .badge[data-status="failed"] .dot, .badge[data-status="cancelled"] .dot { background: #d92d20; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 12px; }
    .meta span { padding: 4px 8px; border-radius: 999px; background: color-mix(in srgb, CanvasText 7%, transparent); }
    .description { margin: 0 0 12px; color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 13px; }
    .output { max-height: 280px; min-height: 72px; margin: 0; padding: 12px; overflow: auto; border-radius: 12px; background: color-mix(in srgb, CanvasText 6%, transparent); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .notice { margin: 8px 0 0; color: #b54708; font-size: 11px; }
    .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; }
    button { min-height: 38px; padding: 8px 13px; border: 0; border-radius: 10px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .55; }
    .primary { color: #fff; background: #111; }
    .secondary { color: CanvasText; background: color-mix(in srgb, CanvasText 9%, transparent); }
    .danger { margin-left: auto; color: #b42318; background: color-mix(in srgb, #d92d20 10%, transparent); }
    .message { min-height: 18px; margin: 10px 0 0; color: color-mix(in srgb, CanvasText 60%, transparent); font-size: 12px; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) { .primary { color: #111; background: #f3f3f3; } .danger { color: #ff8a80; } }
    @media (max-width: 440px) { header { display: block; } .badge { margin-top: 12px; } .danger { margin-left: 0; } }
  </style>
</head>
<body>
  <main class="card" aria-live="polite">
    <header>
      <div><p class="eyebrow">HARNESS X HARNESS · CODE TASK</p><h1 id="title">Preparing task</h1></div>
      <span id="badge" class="badge" data-status="queued"><span class="dot"></span><span id="status">Queued</span></span>
    </header>
    <div class="meta"><span id="executor">executor</span><span id="mode">mode</span></div>
    <p id="description" class="description">Waiting for the runner.</p>
    <pre id="output" class="output">Live output will appear here.</pre>
    <p id="notice" class="notice" hidden>Earlier live events are no longer retained.</p>
    <div class="actions">
      <button id="authorize" class="primary" type="button" hidden>Authorize repository</button>
      <button id="run" class="secondary" type="button" hidden>View GitHub run</button>
      <button id="pullRequest" class="secondary" type="button" hidden>Open pull request</button>
      <button id="cancel" class="danger" type="button">Cancel task</button>
    </div>
    <p id="message" class="message" role="status"></p>
  </main>
  <script>
    const controlPlaneOrigin = ${JSON.stringify(controlPlaneOrigin)};
    const elements = Object.fromEntries(["title", "badge", "status", "executor", "mode", "description", "output", "notice", "authorize", "run", "pullRequest", "cancel", "message"].map(id => [id, document.getElementById(id)]));
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let current = {};
    let cursor = 0;
    let streamGeneration = 0;
    let outputStarted = false;

    function safeUrl(value, kind) {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") return undefined;
        if (kind === "stream" && (url.origin !== controlPlaneOrigin || !url.pathname.startsWith("/task-stream/"))) return undefined;
        if (kind === "authorize" && url.origin !== controlPlaneOrigin) return undefined;
        if ((kind === "run" || kind === "pullRequest") && url.origin !== "https://github.com") return undefined;
        return url.href;
      } catch { return undefined; }
    }

    function renderTask(value) {
      current = { ...current, ...(value && typeof value === "object" ? value : {}) };
      current.id = current.id || current.taskId;
      const descriptions = {
        awaiting_installation: "Repository authorization is required before this task can start.",
        dispatching: "Creating the GitHub Actions run.", queued: "Waiting for the runner.",
        running: "The coding agent is working.", testing: "Checking the workspace changes.",
        committing: "Publishing the task changes.", completed: "The task completed successfully.",
        failed: "The task failed.", cancel_requested: "Cancellation was requested.", cancelled: "The task was cancelled."
      };
      const status = descriptions[current.status] ? current.status : "queued";
      elements.badge.dataset.status = status;
      elements.status.textContent = status.replaceAll("_", " ");
      elements.title.textContent = current.repo || "Code task";
      elements.executor.textContent = current.executor || "executor";
      elements.mode.textContent = current.mode || "mode";
      elements.description.textContent = descriptions[status];
      setLink(elements.authorize, safeUrl(current.authorizationUrl, "authorize"));
      setLink(elements.run, safeUrl(current.runUrl, "run"));
      setLink(elements.pullRequest, safeUrl(current.result?.pullRequest, "pullRequest"));
      elements.cancel.hidden = ["completed", "failed", "cancelled"].includes(status);
      if (current.result?.summary) {
        elements.output.textContent = current.result.summary;
        outputStarted = true;
      }
    }

    function setLink(element, href) {
      element.hidden = !href;
      element.dataset.href = href || "";
    }

    function applyEvent(event) {
      if (!event || !Number.isSafeInteger(event.seq) || event.seq <= cursor) return;
      cursor = event.seq;
      if (event.type === "status") { renderTask(event.data); return; }
      if (!outputStarted) { elements.output.textContent = ""; outputStarted = true; }
      if (event.type === "message_delta") elements.output.textContent += event.data?.text || "";
      if (event.type === "message") elements.output.textContent += (elements.output.textContent ? "\\n" : "") + (event.data?.text || "");
      if (event.type === "activity") elements.output.textContent += (elements.output.textContent ? "\\n" : "") + "• " + (event.data?.label || "Activity");
      elements.output.scrollTop = elements.output.scrollHeight;
    }

    async function startStream(meta) {
      const streamUrl = safeUrl(meta?.taskStream?.url, "stream");
      const token = typeof meta?.taskStream?.token === "string" ? meta.taskStream.token : "";
      if (!streamUrl || !token) return;
      const generation = ++streamGeneration;
      while (generation === streamGeneration && !["completed", "failed", "cancelled"].includes(current.status)) {
        const url = new URL(streamUrl);
        url.searchParams.set("after", String(cursor));
        const response = await fetch(url, { headers: { authorization: "Bearer " + token }, cache: "no-store" });
        if (!response.ok || !response.body) { elements.message.textContent = "Live output is unavailable."; return; }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (generation === streamGeneration) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\\n");
          buffered = lines.pop() || "";
          for (const line of lines) {
            if (!line) continue;
            const item = JSON.parse(line);
            if (item.type === "snapshot") {
              renderTask(item.task);
              elements.notice.hidden = !item.truncated;
              for (const event of item.events || []) applyEvent(event);
            } else applyEvent(item);
          }
        }
        if (["completed", "failed", "cancelled"].includes(current.status)) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    function request(method, params) {
      const id = nextRequestId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => pendingRequests.set(id, { resolve, reject }));
    }

    function notify(method) { window.parent.postMessage({ jsonrpc: "2.0", method }, "*"); }

    async function openLink(href) { if (href) await request("ui/open-link", { url: href }); }

    async function cancelTask() {
      elements.cancel.disabled = true;
      elements.message.textContent = "Requesting cancellation…";
      const result = await request("tools/call", { name: "cancel_task", arguments: { taskId: current.id } });
      if (result?.structuredContent) renderTask(result.structuredContent);
      elements.cancel.disabled = false;
      elements.message.textContent = "";
    }

    window.addEventListener("message", event => {
      if (event.source !== window.parent) return;
      const incoming = event.data;
      if (!incoming || incoming.jsonrpc !== "2.0") return;
      if (incoming.id !== undefined && pendingRequests.has(incoming.id)) {
        const pending = pendingRequests.get(incoming.id); pendingRequests.delete(incoming.id);
        if (incoming.error) pending.reject(incoming.error); else pending.resolve(incoming.result);
        return;
      }
      if (incoming.method === "ui/notifications/tool-result") {
        renderTask(incoming.params?.structuredContent);
        startStream(incoming.params?._meta);
      }
    }, { passive: true });

    elements.authorize.addEventListener("click", () => openLink(elements.authorize.dataset.href));
    elements.run.addEventListener("click", () => openLink(elements.run.dataset.href));
    elements.pullRequest.addEventListener("click", () => openLink(elements.pullRequest.dataset.href));
    elements.cancel.addEventListener("click", cancelTask);

    async function connect() {
      await request("ui/initialize", { appCapabilities: {}, appInfo: { name: "Harness X Harness Code Task", version: "1.0.0" }, protocolVersion: "2026-01-26" });
      notify("ui/notifications/initialized");
    }
    connect();
  </script>
</body>
</html>`;
}
