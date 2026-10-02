import { useEffect, useRef, useState } from "react";
import { Button } from "./components/button.tsx";
import { ConfirmDialog } from "./components/confirm-dialog.tsx";
import { QuestionForm } from "./questions.tsx";
import { cancelArguments, commandFailed, commandText, commandTitle, connectionNote, decidePromptSend, executorName, finalText, listStatus, modelLine, nextSentence, operationStatusText, questionFields, refreshArguments, relativeTime, stateLabel, type PromptLease, type View } from "./view.ts";

type Confirm = { kind: "stop" | "close"; id: string } | undefined;

export function Screen({ view, error, busy, connected, canCall, canMessage, now, creationKey, onCall, onSend, onMessage }: {
  view?: View;
  error: string;
  busy: boolean;
  connected: boolean;
  canCall: boolean;
  canMessage: boolean;
  now: number;
  creationKey: string;
  onCall: (name: string, args: Record<string, unknown>) => void;
  onSend: (args: { environmentId: string; prompt: string; idempotencyKey: string }) => Promise<"sent" | "rejected" | "unknown">;
  onMessage: (action: "explain" | "answer") => void;
}) {
  const [confirm, setConfirm] = useState<Confirm>();
  const [prompt, setPrompt] = useState("");
  const [lease, setLease] = useState<PromptLease>();
  const snapshot = view?.kind === "environment" ? view.snapshot : undefined;
  const environmentId = snapshot?.environmentId;
  const previousEnvironment = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousEnvironment.current;
    if (environmentId) previousEnvironment.current = environmentId;
    if (!environmentId || !previous || previous === environmentId) return;
    setPrompt("");
    setLease(current => current?.environmentId === environmentId ? current : undefined);
  }, [environmentId]);
  const label = snapshot ? stateLabel(snapshot) : undefined;
  const phase = snapshot?.environmentStatus;
  const failed = snapshot !== undefined && (snapshot.operationStatus === "failed" || commandFailed(snapshot));
  const tone = phase === "unavailable" || failed ? "bad"
    : phase === "opening" || phase === "closing" || snapshot?.operationStatus === "cancelled" || Boolean(snapshot?.questions?.length) || Boolean(snapshot && cancelArguments(snapshot)) ? "warn" : "good";
  const command = snapshot ? commandText(snapshot) : undefined;
  const prose = snapshot && !command ? finalText(snapshot) : undefined;
  const canWork = snapshot?.environmentStatus === "ready" && !cancelArguments(snapshot);
  const showPrompt = Boolean(canWork && !snapshot?.questions?.length);
  const unsupported = snapshot?.questions?.some(question => !questionFields(question)) ?? false;
  const viewedAt = view ? Math.max(now, view.receivedAt) : now;
  const viewed = view ? relativeTime(view.receivedAt, viewedAt) : "";
  const clock = viewed === "刚刚" ? "刚刚更新" : `${viewed}更新`;
  const operationText = snapshot ? operationStatusText(snapshot) : undefined;
  const promptText = prompt.trim();
  const unconfirmed = Boolean(lease && promptText !== "" && promptText !== lease.text);
  return <main aria-busy={busy}>
    <header>
      <div className="brand"><span className="mark" aria-hidden="true" /><strong>AgentEnv</strong></div>
      {label && <span className={`status ${tone}`} aria-hidden="true">{label}</span>}
    </header>
    {error && <p className="error" role="alert">{error}</p>}
    {!view && <p role="status">{connected ? "正在加载…" : "正在连接…"}</p>}
    {view?.kind === "list" && <section>
      {view.environments.length === 0 ? <>
        <h1>选择助手</h1>
        <p>同时只能有一个工作区。</p>
        <div className="choices">
          {(["codex", "grok"] as const).map(executor => <Button className="choice" variant="primary" key={executor} disabled={!canCall}
            onClick={() => onCall("open_environment", { executor, idempotencyKey: creationKey })}>
            <strong>{executorName(executor)}</strong><small>{executor === "codex" ? "打开 Codex" : "打开 Grok"}</small>
          </Button>)}
        </div>
      </> : <>
        <h1>工作区</h1>
        {view.environments.map(env => <Button className="choice" key={env.environmentId} disabled={!canCall}
          onClick={() => onCall("inspect_environment", { environmentId: env.environmentId })}>
          <strong>{executorName(env.executor)}</strong><small>{listStatus(env, now)}</small>
        </Button>)}
      </>}
    </section>}
    {view?.kind === "capacity" && <section>
      <h1>{view.capacityKind === "owner" ? "已有工作区" : "没有可用名额"}</h1>
      <p role="status">{view.capacityKind === "owner"
        ? "请先关闭当前工作区。"
        : "请稍后重试。"}</p>
      {view.existing && <Button variant="primary" disabled={!canCall}
        onClick={() => onCall("inspect_environment", { environmentId: view.existing!.environmentId })}>打开</Button>}
      {view.capacityKind === "global" && view.executor && view.idempotencyKey && <Button variant="primary" disabled={!canCall}
        onClick={() => onCall("open_environment", { executor: view.executor, idempotencyKey: view.idempotencyKey })}>重试</Button>}
    </section>}
    {snapshot && <section>
      <h1>{executorName(snapshot.executor)}</h1>
      {nextSentence(snapshot) && <p role="status">{nextSentence(snapshot)}</p>}
      {modelLine(snapshot) && <p className="muted">{modelLine(snapshot)}</p>}
      {!!snapshot.questions?.length && snapshot.questions.map(question => <QuestionForm key={`${question.operationId}:${question.id}`}
        question={question} disabled={!canCall || snapshot.environmentStatus !== "ready"}
        answer={(question, response) => onCall("update_operation", {
          operationId: question.operationId, action: "answer", inputResponses: { [question.id]: response },
        })} />)}
      {unsupported && <Button variant="quiet" disabled={!canMessage || snapshot.environmentStatus !== "ready"} onClick={() => onMessage("answer")}>在对话中回答</Button>}
      {snapshot.output?.text && <details open={!prose && !command && Boolean(cancelArguments(snapshot))}>
        <summary>进度</summary>
        <pre>{snapshot.output.text}</pre>
        {snapshot.output.truncated && <p className="muted">输出未完整显示。</p>}
      </details>}
      {command && <div className="result-block">
        <h2>{commandTitle(command)}</h2>
        {command.stdout || command.stderr ? <pre>{`${command.stdout}${command.stderr ? `\n${command.stderr}` : ""}`}</pre> : <p className="muted">无输出。</p>}
        {command.truncated && <p className="muted">输出未完整显示。</p>}
      </div>}
      {prose !== undefined && <div className="result-block"><h2>结果</h2><p className="result">{prose}</p></div>}
      {showPrompt && <form className="prompt" onSubmit={event => {
        event.preventDefault();
        const text = prompt.trim();
        if (!text || !canCall) return;
        const decision = decidePromptSend(lease, snapshot.environmentId, text, crypto.randomUUID());
        if (decision.action === "blocked") return;
        setLease(decision.lease);
        void onSend({ environmentId: snapshot.environmentId, prompt: text, idempotencyKey: decision.key }).then(result => {
          if (result === "sent" || result === "rejected") setLease(undefined);
          if (result === "sent") setPrompt("");
        });
      }}>
        <label className="px-label" htmlFor="next-request">指令</label>
        <textarea id="next-request" value={prompt} disabled={!canCall} placeholder="输入指令"
          onChange={event => setPrompt(event.target.value)} />
        {unconfirmed && <p className="error" role="status">未收到响应。请先重试原指令。</p>}
        <Button type="submit" variant="primary" disabled={!canCall || promptText === "" || unconfirmed}>发送</Button>
      </form>}
      {prose !== undefined && <Button variant="quiet" disabled={!canMessage} onClick={() => onMessage("explain")}>解释结果</Button>}
      {cancelArguments(snapshot) && <Button variant="quiet" disabled={!canCall}
        onClick={() => setConfirm({ kind: "stop", id: snapshot.activeOperationId! })}>停止</Button>}
      <details className="details">
        <summary>详情</summary>
        <dl>
          <dt>工作区</dt><dd>{snapshot.environmentId}</dd>
          {snapshot.operationId && <><dt>操作</dt><dd>{snapshot.operationId}</dd></>}
          {operationText && <><dt>状态</dt><dd>{operationText}</dd></>}
          {snapshot.activeOperationId && snapshot.activeOperationId !== snapshot.operationId && <><dt>当前操作</dt><dd>{snapshot.activeOperationId}</dd></>}
          {snapshot.expiresAt !== null && <><dt>关闭时间</dt><dd>{relativeTime(snapshot.expiresAt, now)}</dd></>}
          {snapshot.idleExpiresAt != null && <><dt>闲置时间</dt><dd>{relativeTime(snapshot.idleExpiresAt, now)}</dd></>}
          {connectionNote(snapshot) && snapshot.environmentStatus === "ready" && <><dt>连接</dt><dd>{connectionNote(snapshot)}</dd></>}
        </dl>
        <p className="muted">刷新不会延长使用时间。</p>
      </details>
    </section>}
    {view && <footer>
      <Button variant="quiet" disabled={!canCall} onClick={() => { const next = refreshArguments(view); onCall(next.name, next.arguments); }}>{busy ? "正在刷新…" : "刷新"}</Button>
      {snapshot && <Button variant="quiet" disabled={!canCall} onClick={() => onCall("list_environments", {})}>列表</Button>}
      {snapshot && snapshot.environmentStatus !== "closed" && <Button variant="danger" disabled={!canCall}
        onClick={() => setConfirm({ kind: "close", id: snapshot.environmentId })}>关闭</Button>}
      <p className="muted">{clock}</p>
    </footer>}
    <ConfirmDialog open={confirm?.kind === "stop"} title="停止此操作？"
      description="已完成的更改将保留。"
      confirmLabel="停止" cancelLabel="取消" danger onOpenChange={open => { if (!open) setConfirm(undefined); }}
      onConfirm={() => { const action = confirm; setConfirm(undefined); if (action?.kind === "stop") onCall("update_operation", { operationId: action.id, action: "cancel" }); }} />
    <ConfirmDialog open={confirm?.kind === "close"} title="关闭此工作区？"
      description="未保存的文件将丢失。"
      confirmLabel="关闭" cancelLabel="取消" danger onOpenChange={open => { if (!open) setConfirm(undefined); }}
      onConfirm={() => { const action = confirm; setConfirm(undefined); if (action?.kind === "close") onCall("close_environment", { environmentId: action.id }); }} />
  </main>;
}
