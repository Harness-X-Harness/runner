import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Screen } from "./screen.tsx";
import { readView, replyMessage, selectedContext, submissionDisposition, userFacingError, type Result, type View } from "./view.ts";

const app = new App({ name: "AgentEnv workbench", version: "1.0.0" }, {});
let latest: View | undefined;
let error = "";
let connected = false;
let busy = false;
let creationKey = crypto.randomUUID();
let failureMessage = "";
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(notify => notify());

async function receive(result: Result): Promise<boolean> {
  try {
    latest = readView(result, Date.now());
    error = "";
    failureMessage = "";
    changed();
    if (app.getHostCapabilities()?.updateModelContext) {
      try { await app.updateModelContext(selectedContext(latest)); }
      catch { error = "未能同步当前选择。"; }
    }
    return true;
  } catch (failure) {
    failureMessage = failure instanceof Error ? failure.message : "";
    error = userFacingError(failureMessage || "操作失败。请刷新。");
    changed();
    return false;
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  error = "";
  failureMessage = "";
  changed();
  let applied = false;
  try {
    const result = await app.callServerTool({ name, arguments: args });
    applied = await receive(result);
    if (name === "open_environment" && latest?.kind === "environment" && !result.isError) creationKey = crypto.randomUUID();
    if (name === "open_environment" && latest?.kind === "capacity") {
      latest = { ...latest,
        executor: args.executor === "grok" ? "grok" : args.executor === "codex" ? "codex" : undefined,
        idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined };
    }
  } catch {
    failureMessage = "";
    error = "未收到响应。请刷新。";
    applied = false;
  } finally {
    busy = false;
    changed();
  }
  return applied;
}

async function message(action: "explain" | "answer") {
  if (busy || latest?.kind !== "environment") return;
  busy = true;
  error = "";
  changed();
  try {
    const result = await app.sendMessage(replyMessage(latest.snapshot, action));
    if (result.isError) error = "消息未发送。";
  } catch {
    error = "消息未确认。请查看对话。";
  } finally {
    busy = false;
    changed();
  }
}

app.ontoolresult = result => { void receive(result); };
app.ontoolcancelled = () => { error = "操作已取消。"; changed(); };
const styleHost = () => {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};
app.onhostcontextchanged = styleHost;

function Workbench() {
  const [, update] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const listener = () => { setNow(Date.now()); update(value => value + 1); };
    listeners.add(listener);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { listeners.delete(listener); clearInterval(timer); };
  }, []);
  return <Screen view={latest} error={error} busy={busy} connected={connected} now={now} creationKey={creationKey}
    canCall={connected && !busy && Boolean(app.getHostCapabilities()?.serverTools)}
    canMessage={connected && !busy && Boolean(app.getHostCapabilities()?.message?.text)}
    onCall={(name, args) => { void call(name, args); }}
    onSend={async args => {
      const sent = await call("agent", args);
      return sent ? "sent" : failureMessage ? submissionDisposition(failureMessage) : "unknown";
    }}
    onMessage={action => { void message(action); }} />;
}

createRoot(document.getElementById("root")!).render(<Workbench />);
void app.connect().then(() => { connected = true; styleHost(); changed(); }).catch(() => {
  error = "未连接到 ChatGPT。";
  changed();
});
