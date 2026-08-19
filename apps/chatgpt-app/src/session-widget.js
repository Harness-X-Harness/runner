import { WIDGET_BASE_STYLES, WIDGET_HOST_CONTEXT_SCRIPT } from "./widget-shell.js";

export const SESSION_WIDGET_URI = "ui://session/v3.html";
export const SESSION_WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

export function sessionWidgetHtml(controlPlaneUrl) {
  const origin = new URL(controlPlaneUrl).origin;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
${WIDGET_BASE_STYLES}
    .badge[data-phase="preparing"] .dot, .badge[data-phase="running"] .dot, .badge[data-phase="stopping"] .dot { background: #b7791f; }
    .badge[data-phase="idle"] .dot { background: #16825d; }
    .badge[data-phase="waiting_for_user"] .dot { background: #7567ad; }
    .badge[data-phase="terminal"] .dot { background: #b42318; }
    :root[data-theme="dark"] .badge[data-phase="terminal"] .dot { background: #ff8a80; }
    .timeline { margin: 14px 0 0; padding: 12px 0 0; border-top: 1px solid var(--border); color: CanvasText; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .request { margin-top: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; }
    .request h2 { margin: 0; font-size: 14px; line-height: 1.4; }
    .request p { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
    select, input { width: 100%; min-height: 38px; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; color: CanvasText; background: transparent; font: inherit; font-size: 13px; }
    label { display: block; margin-top: 10px; color: var(--muted); font-size: 12px; }
    label input { display: block; color: CanvasText; }
    .queue { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <main class="card">
    <header>
      <div>
        <h1 id="title">Coding session</h1>
        <p id="subtitle" class="subtitle">Preparing the session.</p>
      </div>
      <span id="badge" class="badge" data-phase="preparing"><span class="dot"></span><span id="phase">Preparing</span></span>
    </header>
    <p id="summary" class="description">Loading the current session state.</p>
    <pre id="timeline" class="timeline" aria-label="Recent session activity">Session events will appear here.</pre>

    <section id="requestPanel" class="request" hidden>
      <h2 id="requestTitle">Agent request</h2>
      <p id="requestDetail"></p>
      <select id="requestChoices" aria-label="Response choice" hidden></select>
      <div id="requestFields"></div>
    </section>

    <p id="queueSummary" class="queue" hidden></p>
    <div id="actions" class="actions" hidden>
      <button id="primary" class="primary" type="button" hidden></button>
      <button id="secondary" class="secondary" type="button" hidden></button>
    </div>
    <p id="message" class="message" role="status" aria-live="polite"></p>
  </main>
  <script>
    const controlPlaneOrigin = ${JSON.stringify(origin)};
    const ids = ["title","subtitle","badge","phase","summary","timeline","requestPanel","requestTitle","requestDetail","requestChoices","requestFields","queueSummary","actions","primary","secondary","message"];
    const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const requests = new Map();
    const events = new Map();
    const fieldInputs = new Map();
    let requestId = 1;
    let current = {};
    let cursor = 0;
    let streamGeneration = 0;

${WIDGET_HOST_CONTEXT_SCRIPT}

    function safeUrl(value, kind) {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") return undefined;
        if (kind === "stream" && (url.origin !== controlPlaneOrigin || !url.pathname.startsWith("/session-stream/"))) return undefined;
        if (kind === "environment" && (url.origin !== controlPlaneOrigin || url.pathname !== "/environment")) return undefined;
        if (kind === "run" && url.origin !== "https://github.com") return undefined;
        return url.href;
      } catch {
        return undefined;
      }
    }

    function renderSession(value) {
      if (!value || typeof value !== "object") return;
      if (Number.isSafeInteger(current.latestCursor) &&
          Number.isSafeInteger(value.latestCursor) &&
          value.latestCursor < current.latestCursor) return;
      current = { ...current, ...value };
      const phase = ["preparing","idle","running","waiting_for_user","stopping","terminal"].includes(current.phase)
        ? current.phase
        : "preparing";
      const labels = {
        preparing: "Preparing",
        idle: "Idle",
        running: "Running",
        waiting_for_user: "Needs response",
        stopping: "Stopping",
        terminal: "Ended",
      };
      const descriptions = {
        preparing: "Preparing a persistent coding agent.",
        idle: "Ready for your next message in chat.",
        running: "The agent is working. Live output appears below.",
        waiting_for_user: "The agent needs your response.",
        stopping: "The coding session is stopping.",
        terminal: "The coding session has ended.",
      };
      const executor = current.executor === "grok" ? "Grok" : current.executor === "codex" ? "Codex" : "Coding";
      const connected = current.channelState === "connected";
      const controller = current.controller?.currentGrant
        ? "You control this session."
        : (current.controller?.clientName || "Another client") + " controls this session.";
      el.badge.dataset.phase = phase;
      el.phase.textContent = labels[phase];
      el.title.textContent = executor + " session";
      el.subtitle.textContent = current.workingDirectory || "Temporary private environment";
      el.summary.textContent = descriptions[phase] + " " + (connected ? "Connected. " : "Agent connection is offline. ") + controller;
      const queued = Array.isArray(current.queuedTurns) ? current.queuedTurns.length : 0;
      el.queueSummary.hidden = queued === 0;
      el.queueSummary.textContent = queued === 1 ? "1 turn is queued." : queued + " turns are queued.";
      renderRequest();
      renderActions(phase);
    }

    function applyEvents(values) {
      for (const event of values || []) {
        if (!event || !Number.isSafeInteger(event.cursor) || event.cursor <= cursor) continue;
        events.set(event.cursor, event);
        cursor = event.cursor;
      }
      while (events.size > 200) events.delete(events.keys().next().value);
      renderTimeline();
      renderRequest();
      renderActions(current.phase);
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
        if (event.type === "user_message") lines.push({ text: "You · " + (data.text || "") });
        if (event.type === "activity") lines.push({ text: "Activity · " + (data.label || "") + (data.status ? " · " + data.status : "") });
        if (event.type === "request") lines.push({ text: "Request · " + (data.title || data.kind || "") + " · " + (data.state || "") });
        if (event.type === "error") lines.push({ text: "Error · " + (data.message || data.code || "Session error") });
      }
      const visible = lines.slice(-5).map(line => truncate(line.text, 1600));
      el.timeline.textContent = visible.length ? visible.join("\\n\\n") : "Session events will appear here.";
    }

    function truncate(value, limit) {
      const text = typeof value === "string" ? value : "";
      return text.length <= limit ? text : "…" + text.slice(-limit);
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
    }

    function renderActions(phase) {
      const allowed = new Set(Array.isArray(current.allowedActions) ? current.allowedActions : []);
      const environmentUrl = safeUrl(current.environment?.entryUrl, "environment");
      const runUrl = safeUrl(current.environment?.runUrl, "run");
      const proposals = [];
      if (allowed.has("respond_to_session") && pendingRequestEvent()) {
        proposals.push({ label: "Respond", action: "respond_to_session" });
      } else if (allowed.has("take_over_session")) {
        proposals.push({ label: "Take control", action: "take_over_session" });
      } else if (allowed.has("interrupt_turn")) {
        proposals.push({ label: "Interrupt turn", action: "interrupt_turn" });
      } else if (phase === "preparing" && runUrl) {
        proposals.push({ label: "View GitHub run", href: runUrl });
      } else if ((phase === "idle" || phase === "terminal") && environmentUrl) {
        proposals.push({ label: "Open environment", href: environmentUrl });
      }
      if (proposals.length < 2 && allowed.has("stop_session")) {
        proposals.push({ label: "Stop session", action: "stop_session", intent: "danger" });
      }
      if (proposals.length < 2 && phase === "terminal" && runUrl) {
        proposals.push({ label: "View GitHub run", href: runUrl });
      }
      if (proposals.length < 2 && allowed.has("take_over_session") && environmentUrl) {
        proposals.push({ label: "Open environment", href: environmentUrl });
      }
      if (proposals.length === 0 && runUrl) proposals.push({ label: "View GitHub run", href: runUrl });
      configureButtons(proposals.slice(0, 2));
    }

    function configureButtons(proposals) {
      const buttons = [el.primary, el.secondary];
      buttons.forEach((button, index) => {
        const proposal = proposals[index];
        button.hidden = !proposal;
        button.textContent = proposal?.label || "";
        button.dataset.action = proposal?.action || "";
        button.dataset.href = proposal?.href || "";
        button.dataset.intent = proposal?.intent || "";
      });
      el.actions.hidden = proposals.length === 0;
    }

    function request(method, params) {
      const id = requestId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => requests.set(id, { resolve, reject }));
    }

    function notify(method) {
      window.parent.postMessage({ jsonrpc: "2.0", method }, "*");
    }

    async function callTool(name, args) {
      setBusy(true);
      try {
        const result = await request("tools/call", { name, arguments: args });
        consumeResult(result);
        return result;
      } catch {
        el.message.textContent = "Could not update the session.";
        return undefined;
      } finally {
        setBusy(false);
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

    function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function openLink(href) {
      if (href) await request("ui/open-link", { url: href });
    }

    function setBusy(busy) {
      el.primary.disabled = busy;
      el.secondary.disabled = busy;
      if (busy) el.message.textContent = "Updating session…";
      else if (el.message.textContent === "Updating session…") el.message.textContent = "";
    }

    function respond() {
      const event = pendingRequestEvent();
      if (!event) return;
      const args = { sessionId: current.sessionId, requestId: event.data.requestId };
      if (!el.requestChoices.hidden) args.choiceId = el.requestChoices.value;
      else args.values = Object.fromEntries([...fieldInputs].map(([name, input]) => [
        name,
        input.type === "checkbox" ? String(input.checked) : input.value,
      ]));
      callTool("respond_to_session", args);
    }

    function perform(button) {
      const action = button.dataset.action;
      if (!action) {
        openLink(button.dataset.href);
        return;
      }
      if (action === "respond_to_session") respond();
      if (action === "take_over_session") callTool(action, { sessionId: current.sessionId });
      if (action === "interrupt_turn") callTool(action, { sessionId: current.sessionId, activeTurnId: current.activeTurnId });
      if (action === "stop_session") callTool(action, { sessionId: current.sessionId });
    }

    el.primary.addEventListener("click", () => perform(el.primary));
    el.secondary.addEventListener("click", () => perform(el.secondary));

    window.addEventListener("message", event => {
      if (event.source !== window.parent) return;
      const incoming = event.data;
      if (!incoming || incoming.jsonrpc !== "2.0") return;
      if (incoming.id !== undefined && requests.has(incoming.id)) {
        const pending = requests.get(incoming.id);
        requests.delete(incoming.id);
        if (incoming.error) pending.reject(incoming.error);
        else pending.resolve(incoming.result);
        return;
      }
      if (incoming.method === "ui/notifications/tool-result") consumeResult(incoming.params);
    }, { passive: true });

    async function connect() {
      await request("ui/initialize", {
        appCapabilities: {},
        appInfo: { name: "Harness X Harness Agent Session", version: "1.0.0" },
        protocolVersion: "2026-01-26",
      });
      notify("ui/notifications/initialized");
    }

    connect();
  </script>
</body>
</html>`;
}
