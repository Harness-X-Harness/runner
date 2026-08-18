export const SESSION_WIDGET_URI = "ui://session/v1.html";
export const SESSION_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export function sessionWidgetHtml(controlPlaneUrl) {
  const origin = new URL(controlPlaneUrl).origin;
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
    header { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
    .eyebrow { margin: 0 0 5px; color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 11px; font-weight: 750; letter-spacing: .12em; }
    h1 { margin: 0; font-size: 18px; line-height: 1.25; }
    .badge { display: inline-flex; gap: 7px; align-items: center; min-height: 28px; padding: 5px 10px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, transparent); font-size: 12px; font-weight: 650; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b8b8b; }
    .badge[data-phase="running"] .dot, .badge[data-phase="preparing"] .dot, .badge[data-phase="stopping"] .dot { background: #e0a21a; }
    .badge[data-phase="idle"] .dot { background: #22a06b; }
    .badge[data-phase="waiting_for_user"] .dot { background: #7b61d1; }
    .badge[data-phase="terminal"] .dot { background: #d92d20; }
    .meta { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; margin: 14px 0; }
    .meta div { min-width: 0; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, CanvasText 6%, transparent); }
    .meta small { display: block; color: color-mix(in srgb, CanvasText 55%, transparent); }
    .meta span { display: block; margin-top: 2px; overflow-wrap: anywhere; font-size: 12px; }
    .timeline { min-height: 112px; max-height: 320px; margin: 0; padding: 12px; overflow: auto; border-radius: 12px; background: color-mix(in srgb, CanvasText 6%, transparent); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .panel { margin-top: 12px; padding: 12px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 12px; }
    .panel h2 { margin: 0 0 9px; font-size: 13px; }
    textarea, select, input { width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 9px; color: CanvasText; background: Canvas; font: inherit; font-size: 13px; }
    textarea { min-height: 78px; resize: vertical; }
    label { display: block; margin: 8px 0 4px; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    button { min-height: 36px; padding: 7px 12px; border: 0; border-radius: 9px; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    .primary { color: #fff; background: #111; }
    .secondary { color: CanvasText; background: color-mix(in srgb, CanvasText 9%, transparent); }
    .danger { color: #b42318; background: color-mix(in srgb, #d92d20 10%, transparent); }
    .message { min-height: 18px; margin: 10px 0 0; color: color-mix(in srgb, CanvasText 60%, transparent); font-size: 12px; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) { .primary { color: #111; background: #f3f3f3; } .danger { color: #ff8a80; } }
    @media (max-width: 460px) { header { display: block; } .badge { margin-top: 10px; } .meta { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="card" aria-live="polite">
    <header>
      <div><p class="eyebrow">HARNESS X HARNESS · AGENT SESSION</p><h1 id="title">Coding session</h1></div>
      <span id="badge" class="badge" data-phase="preparing"><span class="dot"></span><span id="phase">Preparing</span></span>
    </header>
    <section class="meta">
      <div><small>Executor</small><span id="executor">—</span></div>
      <div><small>Channel</small><span id="channel">—</span></div>
      <div><small>Controller</small><span id="controller">—</span></div>
      <div><small>Working directory</small><span id="cwd">—</span></div>
      <div><small>Environment</small><span id="environment">—</span></div>
    </section>
    <pre id="timeline" class="timeline">Session events will appear here.</pre>

    <section id="requestPanel" class="panel" hidden>
      <h2 id="requestTitle">Agent request</h2>
      <p id="requestDetail"></p>
      <select id="requestChoices" hidden></select>
      <div id="requestFields"></div>
      <div class="actions"><button id="respond" class="primary" type="button">Respond</button></div>
    </section>

    <section id="queuePanel" class="panel" hidden>
      <h2>Queued turns</h2>
      <select id="queuedTurns"></select>
      <div class="actions"><button id="cancelQueued" class="secondary" type="button">Cancel selected turn</button></div>
    </section>

    <section class="panel">
      <h2>Continue the session</h2>
      <textarea id="composer" placeholder="Tell the agent what to do next."></textarea>
      <div class="actions">
        <button id="steer" class="primary" type="button">Steer now</button>
        <button id="queue" class="secondary" type="button">Queue</button>
        <button id="interrupt" class="secondary" type="button">Interrupt turn</button>
        <button id="takeover" class="secondary" type="button">Take control</button>
        <button id="stop" class="danger" type="button">Stop session</button>
      </div>
    </section>

    <div class="actions">
      <button id="openEnvironment" class="secondary" type="button">Open environment</button>
      <button id="viewRun" class="secondary" type="button">View GitHub run</button>
    </div>
    <p id="message" class="message" role="status"></p>
  </main>
  <script>
    const controlPlaneOrigin = ${JSON.stringify(origin)};
    const ids = ["title","badge","phase","executor","channel","controller","cwd","environment","timeline","requestPanel","requestTitle","requestDetail","requestChoices","requestFields","respond","queuePanel","queuedTurns","cancelQueued","composer","steer","queue","interrupt","takeover","stop","openEnvironment","viewRun","message"];
    const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const requests = new Map();
    const events = new Map();
    const fieldInputs = new Map();
    let requestId = 1;
    let current = {};
    let cursor = 0;
    let streamGeneration = 0;

    function safeUrl(value, kind) {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") return undefined;
        if (kind === "stream" && (url.origin !== controlPlaneOrigin || !url.pathname.startsWith("/session-stream/"))) return undefined;
        if (kind === "environment" && (url.origin !== controlPlaneOrigin || url.pathname !== "/environment")) return undefined;
        if (kind === "run" && url.origin !== "https://github.com") return undefined;
        return url.href;
      } catch { return undefined; }
    }

    function renderSession(value) {
      if (!value || typeof value !== "object") return;
      current = { ...current, ...value };
      const phase = ["preparing","idle","running","waiting_for_user","stopping","terminal"].includes(current.phase) ? current.phase : "preparing";
      el.badge.dataset.phase = phase;
      el.phase.textContent = phase.replaceAll("_", " ");
      el.title.textContent = current.sessionId || "Coding session";
      el.executor.textContent = current.executor || "—";
      el.channel.textContent = current.channelState || "disconnected";
      el.controller.textContent = (current.controller?.clientName || "Unknown") + (current.controller?.currentGrant ? " · you" : "");
      el.cwd.textContent = current.workingDirectory || "—";
      el.environment.textContent = current.environment?.status || "offline";
      el.openEnvironment.dataset.href = safeUrl(current.environment?.entryUrl, "environment") || "";
      el.openEnvironment.hidden = !el.openEnvironment.dataset.href;
      el.viewRun.dataset.href = safeUrl(current.environment?.runUrl, "run") || "";
      el.viewRun.hidden = !el.viewRun.dataset.href;
      const controller = current.controller?.currentGrant === true;
      const mutable = controller && !["stopping","terminal"].includes(phase);
      el.steer.disabled = !mutable || current.channelState !== "connected" || !["idle","running"].includes(phase);
      el.queue.disabled = !mutable || !["idle","running","waiting_for_user"].includes(phase);
      el.interrupt.disabled = !mutable || phase !== "running" || !current.activeTurnId;
      el.stop.disabled = !mutable;
      el.takeover.hidden = controller || ["stopping","terminal"].includes(phase);
      renderQueue();
      renderRequest();
    }

    function applyEvents(values) {
      for (const event of values || []) {
        if (!event || !Number.isSafeInteger(event.cursor) || event.cursor <= cursor) continue;
        events.set(event.cursor, event);
        cursor = event.cursor;
      }
      renderTimeline();
      renderRequest();
    }

    function renderTimeline() {
      const lines = [];
      for (const event of [...events.values()].sort((a, b) => a.cursor - b.cursor)) {
        const data = event.data || {};
        if (event.type === "agent_message_chunk") {
          const previous = lines.at(-1);
          if (previous?.agent && previous.turnId === data.turnId) previous.text += data.text || "";
          else lines.push({ agent: true, turnId: data.turnId, text: "Agent · " + (data.text || "") });
          continue;
        }
        if (event.type === "user_message") lines.push({ text: "You · " + data.delivery + "\\n" + (data.text || "") });
        if (event.type === "activity") lines.push({ text: "Activity · " + (data.label || "") + (data.status ? " · " + data.status : "") });
        if (event.type === "turn") lines.push({ text: "Turn " + (data.turnId || "") + " · " + (data.status || "") });
        if (event.type === "request") lines.push({ text: "Request · " + (data.title || data.kind || "") + " · " + (data.state || "") });
        if (event.type === "status") lines.push({ text: "Session · " + (data.phase || data.channelState || data.controllerName || data.terminalReason || "updated") });
        if (event.type === "error") lines.push({ text: "Error · " + (data.message || data.code || "Session error") });
      }
      el.timeline.textContent = lines.length ? lines.map(line => line.text).join("\\n\\n") : "Session events will appear here.";
      el.timeline.scrollTop = el.timeline.scrollHeight;
    }

    function pendingRequestEvent() {
      const pending = current.pendingRequests?.[0];
      if (!pending) return undefined;
      return [...events.values()].reverse().find(event =>
        event.type === "request" && event.data?.requestId === pending.requestId && event.data?.state === "open");
    }

    function renderRequest() {
      const event = pendingRequestEvent();
      el.requestPanel.hidden = !event;
      fieldInputs.clear();
      el.requestFields.replaceChildren();
      el.requestChoices.replaceChildren();
      if (!event) return;
      const data = event.data;
      el.requestTitle.textContent = data.title || "Agent request";
      el.requestDetail.textContent = data.detail || "";
      const choices = Array.isArray(data.choices) ? data.choices : [];
      el.requestChoices.hidden = choices.length === 0;
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.choiceId;
        option.textContent = choice.label;
        el.requestChoices.appendChild(option);
      }
      for (const [name, field] of Object.entries(data.inputSchema?.properties || {})) {
        const label = document.createElement("label");
        label.textContent = field.title || name;
        const input = document.createElement("input");
        input.dataset.field = name;
        input.type = field.type === "number" ? "number" : field.type === "boolean" ? "checkbox" : "text";
        label.appendChild(input);
        el.requestFields.appendChild(label);
        fieldInputs.set(name, input);
      }
      el.respond.disabled = current.controller?.currentGrant !== true;
    }

    function renderQueue() {
      const queued = Array.isArray(current.queuedTurns) ? current.queuedTurns : [];
      el.queuePanel.hidden = queued.length === 0;
      el.queuedTurns.replaceChildren();
      for (const turn of queued) {
        const option = document.createElement("option");
        option.value = turn.turnId;
        option.textContent = turn.turnId;
        el.queuedTurns.appendChild(option);
      }
      el.cancelQueued.disabled = current.controller?.currentGrant !== true;
    }

    function request(method, params) {
      const id = requestId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => requests.set(id, { resolve, reject }));
    }

    function notify(method) { window.parent.postMessage({ jsonrpc: "2.0", method }, "*"); }

    async function callTool(name, args) {
      el.message.textContent = "Updating session…";
      try {
        const result = await request("tools/call", { name, arguments: args });
        consumeResult(result);
        return result;
      } catch {
        el.message.textContent = "Could not update the session.";
        return undefined;
      } finally {
        if (el.message.textContent === "Updating session…") el.message.textContent = "";
      }
    }

    function consumeResult(result) {
      const structured = result?.structuredContent;
      if (structured?.events) applyEvents(structured.events);
      renderSession(structured?.session || structured);
      if (result?._meta?.sessionStream) startStream(result._meta.sessionStream);
    }

    async function startStream(meta) {
      const url = safeUrl(meta?.url, "stream");
      const token = typeof meta?.token === "string" ? meta.token : "";
      if (!url || !token) return;
      const generation = ++streamGeneration;
      while (generation === streamGeneration && current.phase !== "terminal") {
        const target = new URL(url);
        target.searchParams.set("after", String(cursor));
        let response;
        try {
          response = await fetch(target, { headers: { authorization: "Bearer " + token }, cache: "no-store" });
        } catch {
          el.message.textContent = "Live connection interrupted. Reconnecting…";
          await delay(1000);
          continue;
        }
        if (response.status === 401) {
          await callTool("read_session", { sessionId: current.sessionId, afterCursor: cursor, limit: 100 });
          return;
        }
        if (!response.ok || !response.body) {
          el.message.textContent = "Live session output is unavailable.";
          return;
        }
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
            renderSession(item.session);
            applyEvents(item.events);
          }
        }
        if (current.phase === "terminal" || generation !== streamGeneration) return;
        await delay(500);
      }
    }

    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    async function openLink(href) { if (href) await request("ui/open-link", { url: href }); }

    el.steer.addEventListener("click", () => send("steer"));
    el.queue.addEventListener("click", () => send("queue"));
    async function send(delivery) {
      const text = el.composer.value.trim();
      if (!text) return;
      const result = await callTool("send_turn", { sessionId: current.sessionId, text, delivery });
      if (result) el.composer.value = "";
    }
    el.cancelQueued.addEventListener("click", () => callTool("cancel_queued_turn", { sessionId: current.sessionId, turnId: el.queuedTurns.value }));
    el.interrupt.addEventListener("click", () => callTool("interrupt_turn", { sessionId: current.sessionId, activeTurnId: current.activeTurnId }));
    el.takeover.addEventListener("click", () => callTool("take_over_session", { sessionId: current.sessionId }));
    el.stop.addEventListener("click", () => callTool("stop_session", { sessionId: current.sessionId }));
    el.respond.addEventListener("click", () => {
      const event = pendingRequestEvent();
      if (!event) return;
      const args = { sessionId: current.sessionId, requestId: event.data.requestId };
      if (!el.requestChoices.hidden) args.choiceId = el.requestChoices.value;
      else args.values = Object.fromEntries([...fieldInputs].map(([name, input]) => [name, input.type === "checkbox" ? String(input.checked) : input.value]));
      callTool("respond_to_session", args);
    });
    el.openEnvironment.addEventListener("click", () => openLink(el.openEnvironment.dataset.href));
    el.viewRun.addEventListener("click", () => openLink(el.viewRun.dataset.href));

    window.addEventListener("message", event => {
      if (event.source !== window.parent) return;
      const incoming = event.data;
      if (!incoming || incoming.jsonrpc !== "2.0") return;
      if (incoming.id !== undefined && requests.has(incoming.id)) {
        const pending = requests.get(incoming.id);
        requests.delete(incoming.id);
        if (incoming.error) pending.reject(incoming.error); else pending.resolve(incoming.result);
        return;
      }
      if (incoming.method === "ui/notifications/tool-result") consumeResult(incoming.params);
    }, { passive: true });

    async function connect() {
      await request("ui/initialize", { appCapabilities: {}, appInfo: { name: "Harness X Harness Agent Session", version: "1.0.0" }, protocolVersion: "2026-01-26" });
      notify("ui/notifications/initialized");
    }
    connect();
  </script>
</body>
</html>`;
}
