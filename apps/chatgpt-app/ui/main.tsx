import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { cancelArguments, finalText, operationBusy, readView, refreshArguments, replyMessage, selectedContext, stateLabel, type Result, type View } from "./view.ts";
import { QuestionForm } from "./questions.tsx";

const app = new App({ name: "AgentEnv workbench", version: "1.0.0" }, {});
let latest: View | undefined;
let error = "";
let connected = false;
let busy = false;
let creationKey = crypto.randomUUID();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(notify => notify());

async function receive(result: Result) {
  try {
    latest = readView(result, Date.now());
    error = "";
    changed();
    if (app.getHostCapabilities()?.updateModelContext) {
      try { await app.updateModelContext(selectedContext(latest)); }
      catch { error = "The snapshot is visible, but selection could not be shared with ChatGPT. Use Continue in ChatGPT to name this environment."; }
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : "The view could not be updated.";
  }
  changed();
}

async function call(name: string, args: Record<string, unknown>) {
  if (busy) return;
  busy = true; error = ""; changed();
  try {
    const result = await app.callServerTool({ name, arguments: args });
    await receive(result);
    if (name === "open_environment" && latest?.kind === "environment" && !result.isError) creationKey = crypto.randomUUID();
  }
  catch { error = "No response was confirmed. View progress before submitting more work. Nothing was retried."; }
  finally { busy = false; changed(); }
}

async function message(action: "explain" | "continue" | "answer") {
  if (busy || latest?.kind !== "environment") return;
  busy = true; error = ""; changed();
  try {
    const result = await app.sendMessage(replyMessage(latest.snapshot, action));
    if (result.isError) error = "ChatGPT did not accept the message. Nothing was retried.";
  } catch { error = "The follow-up message was not confirmed. Check the conversation before sending again."; }
  finally { busy = false; changed(); }
}

app.ontoolresult = result => { void receive(result); };
app.ontoolcancelled = () => { error = "The tool call was cancelled. This does not confirm that an environment stopped."; changed(); };
const styleHost = () => {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};
app.onhostcontextchanged = styleHost;

function time(value: number) { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }

function Workbench() {
  const [, update] = useState(0);
  const [confirm, setConfirm] = useState<{ kind: "stop" | "close"; id: string }>();
  useEffect(() => { const listener = () => update(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const view = latest;
  const s = view?.kind === "environment" ? view.snapshot : undefined;
  const result = s ? finalText(s) : undefined;
  const disabled = !connected || busy || !app.getHostCapabilities()?.serverTools;
  const messageDisabled = !connected || busy || !app.getHostCapabilities()?.message?.text;
  const canWork = s?.environmentStatus === "ready" && !operationBusy(s);
  return <main aria-busy={busy}>
    <header><div className="brand"><span className="mark" aria-hidden="true">A</span><div><strong>AgentEnv</strong><p>Your development workspace</p></div></div>
      {s && <span className="status">{stateLabel(s)}</span>}</header>
    {error && <p className="error" role="alert">{error}</p>}
    {!view && <p role="status">{connected ? "Waiting for the tool result." : "Connecting to ChatGPT…"}</p>}
    {view?.kind === "list" && <section>
      <h1>Your environments</h1>
      {view.environments.length === 0 ? <><p>Choose the coding agent for your temporary workspace.</p><div className="actions">
        {(["codex", "grok"] as const).map(executor => <button key={executor} disabled={disabled}
          onClick={() => void call("open_environment", { executor, idempotencyKey: creationKey })}>Open {executor === "codex" ? "Codex" : "Grok"}</button>)}
      </div></> :
        view.environments.map(env => <button className="environment-row" key={env.environmentId} disabled={disabled}
          onClick={() => void call("inspect_environment", { environmentId: env.environmentId })}>
          <span><strong>{env.executor === "codex" ? "Codex" : "Grok"}</strong><small>{env.environmentId}</small></span><span>{env.status} →</span>
        </button>)}
    </section>}
    {s && <>
      <section><h1>{s.executor === "codex" ? "Codex" : "Grok"} environment</h1>
        <p>{s.environmentStatus === "opening" ? "Your temporary workspace is starting. This snapshot does not confirm readiness." :
          s.environmentStatus === "closing" ? "Closure requested. The runner has not yet been confirmed stopped." :
          s.environmentStatus === "closed" ? "This environment has ended. Retained results remain readable until expiry." :
          s.environmentStatus === "unavailable" ? "The runner is disconnected. This is not confirmation that it stopped." :
          "Use the ChatGPT input box to send your next request in this environment."}</p>
        {s.environmentReason && <p>{s.environmentReason}</p>}
        <details><summary>Environment details</summary><dl><dt>Environment</dt><dd>{s.environmentId}</dd>
          {s.operationId && <><dt>Selected operation</dt><dd>{s.operationId} · {s.operationStatus}</dd></>}
          {s.activeOperationId && <><dt>Current operation</dt><dd>{s.activeOperationId} · {s.activeOperationStatus ?? "Not observed"}</dd></>}
          {s.expiresAt !== null && <><dt>Hard deadline</dt><dd>{time(s.expiresAt)}</dd></>}
          {s.idleExpiresAt != null && <><dt>Idle deadline</dt><dd>{time(s.idleExpiresAt)}</dd></>}
        </dl><p>Viewing progress does not extend these deadlines.</p></details>
      </section>
      {s.historical && <p className="notice">You are viewing an earlier operation. Current questions still need attention.</p>}
      {!!s.questions?.length && <section><h2>Needs your answer</h2>{s.questions.map(question => <QuestionForm key={`${question.operationId}:${question.id}`} question={question}
        disabled={disabled || s.environmentStatus !== "ready"} answer={(question, response) => void call("update_operation", {
          operationId: question.operationId, action: "answer", inputResponses: { [question.id]: response },
        })} />)}
        <button disabled={messageDisabled || s.environmentStatus !== "ready"} onClick={() => void message("answer")}>Answer in ChatGPT</button>
      </section>}
      {s.output?.text && <details open={!result}><summary>Progress snapshot{s.output.truncated ? " · truncated" : ""}</summary><pre>{s.output.text}</pre></details>}
      {result !== undefined && <section><h2>Final result</h2><pre>{result}</pre><p className="muted">Execution completed. Review the result to confirm your request was met.</p></section>}
      {s.operationStatus === "failed" && <p className="error">The operation failed. Ask ChatGPT to inspect its result before starting more work.</p>}
      <div className="actions">
        {canWork && <button disabled={messageDisabled} onClick={() => void message("continue")}>Continue in ChatGPT</button>}
        {result !== undefined && <button disabled={messageDisabled} onClick={() => void message("explain")}>Explain result</button>}
        {cancelArguments(s) && <button disabled={disabled} onClick={() => setConfirm({ kind: "stop", id: s.activeOperationId! })}>Stop operation</button>}
        {s.environmentStatus !== "closed" && <button className="danger" disabled={disabled} onClick={() => setConfirm({ kind: "close", id: s.environmentId })}>Close environment</button>}
      </div>
      {confirm && <section className="notice" role="group" aria-label="Confirm action"><p>{confirm.kind === "stop"
        ? "Stop the current operation? The environment will remain open. External changes cannot be undone."
        : "Close this environment and stop its runner? Uncommitted workspace files will be lost."}</p><div className="actions">
        <button className="danger" disabled={disabled} onClick={() => {
          const action = confirm; setConfirm(undefined);
          if (action.kind === "close") void call("close_environment", { environmentId: action.id });
          else void call("update_operation", { operationId: action.id, action: "cancel" });
        }}>Confirm {confirm.kind === "stop" ? "stop" : "close"}</button><button disabled={disabled} onClick={() => setConfirm(undefined)}>Keep working</button>
      </div></section>}
    </>}
    {view && <footer><button disabled={disabled} onClick={() => { const next = refreshArguments(view); void call(next.name, next.arguments); }}>
      {busy ? "Request in progress…" : "View progress"}</button>
      {s && <button disabled={disabled} onClick={() => void call("list_environments", {})}>Your environments</button>}
      <p className="muted">Last viewed {time(view.receivedAt)} · Updates only when requested</p></footer>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Workbench />);
void app.connect().then(() => { connected = true; styleHost(); changed(); }).catch(() => {
  error = "The ChatGPT UI connection is unavailable. You can still use the tools in chat."; changed();
});
