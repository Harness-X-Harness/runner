import { useEffect, useRef, useState } from "react";
import { Button } from "./components/button.tsx";
import { ConfirmDialog } from "./components/confirm-dialog.tsx";
import { Icon } from "./components/icon.tsx";
import { MarkdownReply } from "./components/markdown-reply.tsx";
import { QuestionForm } from "./questions.tsx";
import { cancelArguments, commandFailed, commandText, commandTitle, connectionNote, decidePromptSend, executorName, finalText, lifecycleLabel, listStatus, modelLine, nextSentence, operationStatusText, questionFields, refreshArguments, relativeTime, type PromptLease, type View } from "./view.ts";

type Confirm = { kind: "stop" | "close"; id: string } | undefined;

export function Screen({ view, error, busy, connected, canCall, canMessage, now, creationKey, onCall, onSend, onMessage, onOpenLink }: {
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
  onMessage: () => void;
  onOpenLink?: (url: string) => void;
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
  const phase = snapshot?.environmentStatus;
  const label = phase ? lifecycleLabel(phase) : undefined;
  const failed = snapshot !== undefined && (snapshot.operationStatus === "failed" || commandFailed(snapshot));
  const tone = phase === "unavailable" ? "bad" : phase === "ready" ? "good" : phase === "closed" ? "off" : "warn";
  const command = snapshot ? commandText(snapshot) : undefined;
  const prose = snapshot && !command ? finalText(snapshot) : undefined;
  const canWork = snapshot?.environmentStatus === "ready" && !cancelArguments(snapshot);
  const showPrompt = Boolean(canWork && !snapshot?.questions?.length);
  const unsupported = snapshot?.questions?.some(question => !questionFields(question)) ?? false;
  const viewedAt = view ? Math.max(now, view.receivedAt) : now;
  const viewed = view ? relativeTime(view.receivedAt, viewedAt) : "";
  const clock = viewed === "刚刚" ? "刚刚更新" : `${viewed}更新`;
  const operationText = snapshot ? operationStatusText(snapshot) : undefined;
  const active = snapshot ? cancelArguments(snapshot) : undefined;
  const progress = prose === undefined && !command ? snapshot?.output : undefined;
  const notice = snapshot ? nextSentence(snapshot) ?? (phase === "ready" ? connectionNote(snapshot) : undefined) : undefined;
  const promptText = prompt.trim();
  const unconfirmed = Boolean(lease && promptText !== "" && promptText !== lease.text);
  return <main aria-busy={busy}>
    <header>
      <div className="identity">
        <div className="brand"><span className="mark" aria-hidden="true" /><strong>AgentEnv</strong></div>
        {snapshot && <div className="executor"><h1>{executorName(snapshot.executor)}</h1>
          {modelLine(snapshot) && <small>{modelLine(snapshot)}</small>}
        </div>}
      </div>
      <div className="controls">
        {label && <span className={`status ${tone}`} role="status" tabIndex={0} data-hint={`工作区：${label}`}>
          <span className="status-bar" aria-hidden="true" />
          <span className={phase === "ready" ? "sr-only" : undefined}>{label}</span>
        </span>}
        {view && <nav aria-label="工作区操作">
          <Button className="icon-button" aria-label="刷新" data-hint={busy ? "正在处理…" : `刷新 · ${clock}`} disabled={!canCall}
            onClick={() => { const next = refreshArguments(view); onCall(next.name, next.arguments); }}><Icon name="refresh" /></Button>
          {snapshot && <Button className="icon-button" aria-label="列表" data-hint="工作区列表" disabled={!canCall}
            onClick={() => onCall("list_environments", {})}><Icon name="list" /></Button>}
          {snapshot && phase !== "closed" && <Button className="icon-button close-button" variant="danger" aria-label="关闭工作区" data-hint="关闭工作区" disabled={!canCall}
            onClick={() => setConfirm({ kind: "close", id: snapshot.environmentId })}><Icon name="power" /></Button>}
        </nav>}
      </div>
    </header>
    {busy && <span className="sr-only" role="status">正在处理…</span>}
    {error && <p className="error" role="alert">{error}</p>}
    {!view && <p role="status">{connected ? "正在加载…" : "正在连接…"}</p>}
    {view?.kind === "list" && <section className="launcher">
      {view.environments.length === 0 ? <>
        <h1>选择助手</h1>
        <p>同时只能有一个工作区。</p>
        <div className="choices">
          {(["codex", "grok"] as const).map(executor => <Button className="choice" key={executor} disabled={!canCall}
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
    {view?.kind === "capacity" && <section className="launcher">
      <h1>{view.capacityKind === "owner" ? "已有工作区" : "没有可用名额"}</h1>
      <p role="status">{view.capacityKind === "owner"
        ? "请先关闭当前工作区。"
        : "请稍后重试。"}</p>
      {view.existing && <Button variant="primary" disabled={!canCall}
        onClick={() => onCall("inspect_environment", { environmentId: view.existing!.environmentId })}>打开</Button>}
      {view.capacityKind === "global" && view.executor && view.idempotencyKey && <Button variant="primary" disabled={!canCall}
        onClick={() => onCall("open_environment", { executor: view.executor, idempotencyKey: view.idempotencyKey })}>重试</Button>}
    </section>}
    {snapshot && <section className="workspace" aria-label="工作内容">
      {notice && <p className="notice" role="status">{notice}</p>}
      {operationText && operationText !== "已完成" && (!active || snapshot.operationId !== active.operationId) && <p className={`operation-state ${failed ? "bad" : ""}`} role="status">{operationText}</p>}
      {!!snapshot.questions?.length && snapshot.questions.map(question => <QuestionForm key={`${question.operationId}:${question.id}`}
        question={question} disabled={!canCall || snapshot.environmentStatus !== "ready"}
        answer={(question, response) => onCall("update_operation", {
          operationId: question.operationId, action: "answer", inputResponses: { [question.id]: response },
        })} />)}
      {unsupported && <Button variant="quiet" disabled={!canMessage || snapshot.environmentStatus !== "ready"} onClick={onMessage}>在对话中回答</Button>}
      {command && <div className={`result-block ${failed ? "failed" : ""}`} role="region" aria-label="命令输出">
        {failed && <h2>{commandTitle(command)}</h2>}
        {command.stdout || command.stderr ? <pre>{`${command.stdout}${command.stderr ? `\n${command.stderr}` : ""}`}</pre> : <p className="muted">无输出。</p>}
        {command.truncated && <p className="muted">输出未完整显示。</p>}
      </div>}
      {prose !== undefined && <div className="result-block" role="region" aria-label="助手回复">
        <MarkdownReply text={prose} onOpenLink={onOpenLink} />
      </div>}
      {(progress?.text || active) && <div className="operation-progress">
        {active && <div className="operation-bar">
          <span className="operation-state" role="status">{snapshot.activeOperationId !== snapshot.operationId ? "当前操作 · " : ""}{snapshot.activeOperationStatus === "input_required" ? "等待输入" : "进行中"}</span>
          <Button variant="quiet" disabled={!canCall}
            onClick={() => setConfirm({ kind: "stop", id: active.operationId })}><Icon name="stop" />停止</Button>
        </div>}
        {progress?.text && <div role="region" aria-label="进度快照">
          <pre>{progress.text}</pre>
          {progress.truncated && <p className="muted">输出未完整显示。</p>}
        </div>}
      </div>}
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
        <label className="sr-only" htmlFor="next-request">指令</label>
        <div className="composer">
          <textarea id="next-request" rows={2} value={prompt} disabled={!canCall} placeholder={prose !== undefined || command ? "继续追问，或开始下一项工作…" : "输入指令，开始工作…"}
            onChange={event => setPrompt(event.target.value)} />
          <Button className="icon-button" type="submit" variant="primary" aria-label="发送" data-hint="发送" disabled={!canCall || promptText === "" || unconfirmed}><Icon name="send" /></Button>
        </div>
        {unconfirmed && <p className="error" role="status">未收到响应。请先重试原指令。</p>}
      </form>}
    </section>}
    {view && <footer className="workspace-meta">
      {snapshot && phase !== "closed" && (snapshot.expiresAt !== null || snapshot.idleExpiresAt != null) && <span className="usage" tabIndex={0} data-hint="刷新不会延长使用时间。">
        {snapshot.idleExpiresAt != null && <span>闲置时间 {relativeTime(snapshot.idleExpiresAt, now)}</span>}
        {snapshot.expiresAt !== null && <span>关闭时间 {relativeTime(snapshot.expiresAt, now)}</span>}
      </span>}
      <span className="freshness" tabIndex={0} data-hint="仅在操作卡片时获取快照">{clock}</span>
    </footer>}
    <ConfirmDialog open={confirm?.kind === "stop"} title="停止此操作？"
      description="已完成的更改将保留。"
      confirmLabel="停止" cancelLabel="取消" danger onOpenChange={open => { if (!open) setConfirm(undefined); }}
      onConfirm={() => { const action = confirm; setConfirm(undefined); if (action?.kind === "stop") onCall("update_operation", { operationId: action.id, action: "cancel" }); }} />
    <ConfirmDialog open={confirm?.kind === "close"} title="关闭此工作区？"
      description="工作区内的所有文件将丢失，包括已保存和仅在本地提交的文件。请先推送或另存到外部。"
      confirmLabel="关闭" cancelLabel="取消" danger onOpenChange={open => { if (!open) setConfirm(undefined); }}
      onConfirm={() => { const action = confirm; setConfirm(undefined); if (action?.kind === "close") onCall("close_environment", { environmentId: action.id }); }} />
  </main>;
}
