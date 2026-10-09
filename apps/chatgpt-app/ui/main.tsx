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
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(notify => notify());

type CallOutcome = "sent" | "rejected" | "unknown";

async function receive(result: Result): Promise<CallOutcome> {
  // Only host-delivered tool results and callServerTool responses enter here.
  // readView validates the display shape; neither it nor the selector authenticates data.
  try {
    latest = readView(result, Date.now());
    error = "";
    changed();
    if (app.getHostCapabilities()?.updateModelContext) {
      try { await app.updateModelContext(selectedContext(latest)); }
      catch { error = "未能同步当前选择。"; }
    }
    return "sent";
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : "";
    error = userFacingError(message || "操作失败。请刷新。");
    changed();
    return submissionDisposition(message);
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  if (busy) return "unknown";
  busy = true;
  error = "";
  changed();
  let outcome: CallOutcome = "unknown";
  try {
    const result = await app.callServerTool({ name, arguments: args });
    outcome = await receive(result);
    if (name === "open_environment" && latest?.kind === "environment" && !result.isError) creationKey = crypto.randomUUID();
    if (name === "open_environment" && latest?.kind === "capacity") {
      latest = { ...latest,
        executor: args.executor === "grok" ? "grok" : args.executor === "codex" ? "codex" : undefined,
        idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined };
    }
  } catch {
    error = "未收到响应。请刷新。";
  } finally {
    busy = false;
    changed();
  }
  return outcome;
}

async function message() {
  if (busy || latest?.kind !== "environment") return;
  busy = true;
  error = "";
  changed();
  try {
    const result = await app.sendMessage(replyMessage(latest.snapshot));
    if (result.isError) error = "消息未发送。";
  } catch {
    error = "消息未确认。请查看对话。";
  } finally {
    busy = false;
    changed();
  }
}

async function openLink(url: string) {
  try {
    const result = await app.openLink({ url });
    if (result.isError) { error = "未能打开链接。"; changed(); }
  } catch { error = "未能打开链接。"; changed(); }
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
    onSend={args => call("agent", args)}
    onMessage={() => { void message(); }}
    onOpenLink={connected && app.getHostCapabilities()?.openLinks ? openLink : undefined} />;
}

createRoot(document.getElementById("root")!).render(<Workbench />);
void app.connect().then(() => { connected = true; styleHost(); changed(); }).catch(() => {
  error = "未连接到 ChatGPT。";
  changed();
});
