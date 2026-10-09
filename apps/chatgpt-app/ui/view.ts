import { z } from "zod";

// This is a display projection, never a lifecycle or authorization authority.
const environment = z.object({
  environmentId: z.string(), executor: z.string(), status: z.string(),
  expiresAt: z.number().nullable(), idleExpiresAt: z.number().nullable().optional(),
  reason: z.string().optional(),
});
const modelSelection = z.object({ model: z.string(), reasoningEffort: z.string() });
const agentDisplay = z.object({
  state: z.object({ selection: modelSelection.nullable(), uncertain: z.boolean() }),
  current: z.boolean(),
});
const reconnectDisplay = z.object({ category: z.string(), observedAt: z.number() });
export const snapshotSchema = z.object({
  contract: z.literal("ordinary"), environmentId: z.string(), executor: z.string(),
  environmentStatus: z.string(), disposition: z.string(), workFinished: z.boolean(),
  expiresAt: z.number().nullable(), idleExpiresAt: z.number().nullable().optional(),
  activeOperationId: z.string().nullable().optional(), activeOperationStatus: z.string().optional(),
  operationId: z.string().optional(), operationStatus: z.string().optional(), historical: z.boolean().optional(),
  environmentReason: z.string().optional(), dispatch: z.string().optional(),
  questions: z.array(z.object({ id: z.string(), operationId: z.string(), message: z.string(),
    requestedSchema: z.record(z.string(), z.unknown()).optional() })).optional(),
  output: z.object({ text: z.string(), truncated: z.boolean(), revision: z.number() }).optional(),
  outcome: z.unknown().optional(),
  agent: z.unknown().optional(),
  reconnectDiagnostic: z.unknown().optional(),
});
const capacitySchema = z.object({
  outcome: z.literal("capacity_rejected"),
  capacityKind: z.enum(["owner", "global"]),
  retryable: z.boolean(),
  existingEnvironment: z.object({ environmentId: z.string(), status: z.string().optional() }).optional(),
});
const listSchema = z.object({ environments: z.array(environment) });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Question = NonNullable<Snapshot["questions"]>[number];
export type Environment = z.infer<typeof environment>;
export type Result = { structuredContent?: unknown; content?: unknown; isError?: boolean };
export type View = { kind: "list"; environments: Environment[]; receivedAt: number }
  | { kind: "environment"; snapshot: Snapshot; receivedAt: number }
  | { kind: "capacity"; capacityKind: "owner" | "global"; retryable: boolean;
      existing?: { environmentId: string; status?: string };
      executor?: "codex" | "grok"; idempotencyKey?: string; receivedAt: number };

export function readView(result: Result, now: number): View {
  const snapshot = snapshotSchema.safeParse(result.structuredContent);
  if (snapshot.success) return { kind: "environment", snapshot: snapshot.data, receivedAt: now };
  const capacity = capacitySchema.safeParse(result.structuredContent);
  if (capacity.success) return { kind: "capacity", capacityKind: capacity.data.capacityKind,
    retryable: capacity.data.retryable, existing: capacity.data.existingEnvironment, receivedAt: now };
  if (result.isError) throw new Error(resultText(result) || "操作未完成。请重试。");
  const list = listSchema.safeParse(result.structuredContent);
  if (list.success) return { kind: "list", environments: list.data.environments, receivedAt: now };
  throw new Error("未返回工作区。请刷新。");
}

const rejectedError = /^(?:INVALID_OPERATION_INPUT|OPERATION_ID_CONFLICT|ENVIRONMENT_NOT_READY|ENVIRONMENT_RUNTIME_BUSY|ENVIRONMENT_CLOSING|ENVIRONMENT_IDLE_EXPIRED|ENVIRONMENT_NOT_FOUND|OPERATION_RECEIPT_CAPACITY|INVALID_INPUT_RESPONSE)$|^Invalid \w+ input:/;

/** An answered rejection did not create unknown work. A missing response stays unknown. */
export function submissionDisposition(message: string): "rejected" | "unknown" {
  return rejectedError.test(message) ? "rejected" : "unknown";
}

const errorCopy: Array<[RegExp, string]> = [
  [/INVALID_OPERATION_INPUT|^Invalid .+ input:/, "输入无效。请修改后再发送。"],
  [/INVALID_INPUT_RESPONSE/, "输入无效。请修改后再提交。"],
  [/OPERATION_ID_CONFLICT/, "请求与已有操作冲突。请修改后再发送。"],
  [/ENVIRONMENT_RUNTIME_BUSY/, "工作区正在执行操作。"],
  [/ENVIRONMENT_NOT_READY/, "工作区未就绪。"],
  [/ENVIRONMENT_CLOSING/, "工作区正在关闭。"],
  [/ENVIRONMENT_IDLE_EXPIRED/, "闲置时间已到。"],
  [/ENVIRONMENT_NOT_FOUND/, "工作区不存在。"],
  [/OPERATION_RECEIPT_CAPACITY/, "操作数量已达上限。"],
];

export function userFacingError(message: string): string {
  for (const [pattern, text] of errorCopy) if (pattern.test(message)) return text;
  if (/^[A-Z0-9_]+$/.test(message)) return "操作失败。请刷新。";
  return message;
}

export function resultText(result: Result): string {
  const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).safeParse(result.content);
  return content.success ? content.data.flatMap(item => item.type === "text" && item.text ? [item.text] : []).join("\n") : "";
}

export function selectedContext(view: View) {
  if (view.kind === "list") return { content: [{ type: "text" as const,
    text: "AgentEnv workbench: no environment selected. Use list_environments to find live environments." }] };
  if (view.kind === "capacity") {
    const text = view.existing
      ? `AgentEnv selection: environmentId=${view.existing.environmentId}. The open was rejected because this environment already exists. Use this environment. Do not open another. This is a snapshot, not live state.`
      : "AgentEnv workbench: no environment selected. Global capacity rejected the open. Do not poll. This is a snapshot, not live state.";
    return { content: [{ type: "text" as const, text }] };
  }
  const s = view.snapshot;
  return { content: [{ type: "text" as const,
    text: `AgentEnv selection: environmentId=${s.environmentId}${s.operationId ? `, operationId=${s.operationId}` : ""}. Last viewed at ${new Date(view.receivedAt).toISOString()}: environment=${s.environmentStatus}${s.operationStatus ? `, operation=${s.operationStatus}` : ""}. This is a snapshot, not live state. Use this environment for the user's next request; do not open another environment or poll.`,
  }] };
}

export function refreshArguments(view: View) {
  if (view.kind === "capacity" && view.existing) return { name: "inspect_environment", arguments: { environmentId: view.existing.environmentId } };
  if (view.kind !== "environment") return { name: "list_environments", arguments: {} };
  return { name: "inspect_environment", arguments: { environmentId: view.snapshot.environmentId,
    ...(view.snapshot.operationId ? { operationId: view.snapshot.operationId } : {}) } };
}

export function operationBusy(s: Snapshot) {
  return Boolean(s.activeOperationId) && !["completed", "failed", "cancelled"].includes(s.activeOperationStatus ?? "");
}

export const commandOutcome = z.object({
  exitCode: z.number().nullable(),
  signal: z.string().nullable().optional(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  stopReason: z.enum(["cancelled", "timeout"]).optional(),
});
export type CommandOutcome = z.infer<typeof commandOutcome>;

export function commandText(s: Snapshot): CommandOutcome | undefined {
  if (s.operationStatus !== "completed" && s.operationStatus !== "cancelled") return undefined;
  const command = commandOutcome.safeParse(s.outcome);
  return command.success ? command.data : undefined;
}

/** Native command failure: non-zero exit, a signal, or timeout. Cancellation is a separate status. */
export function commandFailure(command: CommandOutcome): boolean {
  return command.exitCode !== 0 || command.signal != null || command.stopReason === "timeout";
}

export function commandFailed(s: Snapshot) {
  const command = commandText(s);
  return command !== undefined && commandFailure(command);
}

export function commandTitle(command: CommandOutcome): string {
  if (command.stopReason === "cancelled") return "已取消";
  if (!commandFailure(command)) return "结果";
  if (command.stopReason === "timeout") return "超时";
  if (command.signal) return `信号 ${command.signal}`;
  if (typeof command.exitCode === "number") return `退出码 ${command.exitCode}`;
  return "失败";
}

export function finalText(s: Snapshot): string | undefined {
  if (s.operationStatus !== "completed") return undefined;
  const agent = z.object({ finalResponse: z.string() }).safeParse(s.outcome);
  if (agent.success) return agent.data.finalResponse;
  const command = commandText(s);
  if (!command) return undefined;
  const head = command.stopReason === "timeout"
    ? `Stopped: timeout${command.signal ? ` (${command.signal})` : ""}`
    : command.signal ? `Signal: ${command.signal}` : `Exit code: ${command.exitCode ?? "none"}`;
  return `${head}\n${command.stdout}${command.stderr ? `\n${command.stderr}` : ""}${command.truncated ? "\n[Output truncated]" : ""}`;
}

export function lifecycleLabel(status: string): string {
  return ({ opening: "启动中", ready: "就绪", closing: "关闭中", closed: "已关闭", unavailable: "不可用" } as Record<string, string>)[status] ?? status;
}

function selectedWorkFailed(s: Snapshot): boolean {
  return s.operationStatus === "failed" || commandFailed(s);
}

export function operationStatusText(s: Snapshot): string | undefined {
  if (!s.operationStatus) return undefined;
  if (s.operationStatus === "cancelled" || commandText(s)?.stopReason === "cancelled") return "已取消";
  if (selectedWorkFailed(s)) return "失败";
  if (s.operationStatus === "completed") return "已完成";
  if (s.operationStatus === "working") return "进行中";
  if (s.operationStatus === "input_required") return "等待输入";
  return undefined;
}

const reasonCopy: Record<string, string> = {
  startup_expired: "启动超时。",
  runtime_expired: "使用时间已到。",
  idle_expired: "闲置时间已到。",
  runtime_disconnected: "连接已断开。",
};
const reconnectCopy: Record<string, string> = {
  runner_identity: "身份验证未通过。",
  handshake: "连接未建立。",
  handshake_rejected: "连接被拒绝。",
  control_plane_rejected: "连接被拒绝。",
  transport_closed: "连接已断开。",
  transport_failure: "连接已中断。",
  unknown: "连接异常。",
};

export function reasonText(reason: string | undefined): string | undefined {
  return reason ? reasonCopy[reason] : undefined;
}

export function modelLine(s: Snapshot): string | undefined {
  const agent = agentDisplay.safeParse(s.agent);
  if (!agent.success) return undefined;
  const selection = agent.data.state.selection;
  if (selection) return agent.data.state.uncertain
    ? `${selection.model} · ${selection.reasoningEffort}，尚未确认`
    : `${selection.model} · ${selection.reasoningEffort}`;
  return agent.data.state.uncertain ? "模型尚未确认" : undefined;
}

export function connectionNote(s: Snapshot): string | undefined {
  const note = reconnectDisplay.safeParse(s.reconnectDiagnostic);
  if (!note.success) return undefined;
  return reconnectCopy[note.data.category] ?? "连接异常。";
}

/** Context beyond the separate Environment indicator and operation outcome. */
export function nextSentence(s: Snapshot): string | undefined {
  if (s.environmentStatus === "unavailable") return reasonText(s.environmentReason) ?? connectionNote(s);
  if (s.historical) return "较早的操作。";
  return undefined;
}

export function relativeTime(target: number, now: number): string {
  const delta = target - now;
  if (Math.abs(delta) < 45_000) return delta > 0 ? "不到 1 分钟后" : "刚刚";
  const minutes = Math.max(1, Math.round(Math.abs(delta) / 60_000));
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const body = minutes < 60 ? `${minutes} 分钟` : hours < 48 ? `${hours} 小时` : `${days} 天`;
  return delta >= 0 ? `${body}后` : `${body}前`;
}

export function listStatus(env: Environment, now: number): string {
  const label = lifecycleLabel(env.status);
  if (env.status === "unavailable") return reasonText(env.reason)?.replace(/。$/, "") ?? "不可用";
  if (env.status === "ready" && env.idleExpiresAt != null) {
    const when = relativeTime(env.idleExpiresAt, now);
    if (when === "刚刚" || when.endsWith("前")) return "闲置时间已到";
    if (when === "不到 1 分钟后") return "即将关闭";
    return `${when}关闭`;
  }
  return label;
}

export function executorName(value: string): string {
  if (value === "codex") return "Codex";
  if (value === "grok") return "Grok";
  return value;
}

export function replyMessage(s: Snapshot) {
  const operationId = s.questions?.[0]?.operationId;
  const target = `environmentId=${s.environmentId}${operationId ? `, operationId=${operationId}` : ""}`;
  return { role: "user" as const, content: [{ type: "text" as const, text: `AgentEnv: ${target}. 请协助回答当前问题。不要开始新的回合。` }] };
}

export function cancelArguments(s: Snapshot) {
  return s.environmentStatus !== "closed" && s.activeOperationId && operationBusy(s)
    ? { operationId: s.activeOperationId, action: "cancel" } : undefined;
}

const fieldSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "array"]), title: z.string().optional(), description: z.string().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  minLength: z.number().optional(), maxLength: z.number().optional(), minimum: z.number().optional(), maximum: z.number().optional(),
  items: z.object({ type: z.literal("string"), enum: z.array(z.string()) }).optional(),
});
export function questionFields(question: Question) {
  const schema = z.object({ type: z.literal("object"), properties: z.record(z.string(), fieldSchema), required: z.array(z.string()).optional() })
    .safeParse(question.requestedSchema);
  if (!schema.success || Object.values(schema.data.properties).some(field => field.type === "array" && !field.items)) return undefined;
  return Object.entries(schema.data.properties).map(([name, field]) => ({ ...field, name, required: schema.data.required?.includes(name) ?? false }));
}

export function answerContent(question: Question, form: FormData): Record<string, unknown> {
  const fields = questionFields(question);
  if (!fields || !question.requestedSchema) throw new Error("请在对话中回答。");
  const content = Object.fromEntries(fields.flatMap(field => {
    const raw = form.get(field.name);
    if (raw === null && field.type !== "boolean" && field.type !== "array") return [];
    if (raw === "" && !field.required) return [];
    if (field.type === "array" && form.getAll(field.name).length === 0 && !field.required) return [];
    const value = field.type === "array" ? form.getAll(field.name)
      : field.enum ? field.enum[Number(raw)] : field.type === "boolean" ? raw === "on"
      : field.type === "number" || field.type === "integer" ? Number(raw) : String(raw);
    return [[field.name, value]];
  }));
  return z.record(z.string(), z.unknown()).parse(z.fromJSONSchema(question.requestedSchema as Parameters<typeof z.fromJSONSchema>[0]).parse(content));
}

export type PromptLease = {
  environmentId: string;
  key: string;
  text: string;
};

/** One key belongs to one unconfirmed prompt. Only that prompt's own response may end it. */
export function decidePromptSend(
  lease: PromptLease | undefined,
  environmentId: string,
  text: string,
  newKey: string,
): { action: "send"; key: string; lease: PromptLease } | { action: "blocked" } {
  const normalized = text.trim();
  if (normalized === "") return { action: "blocked" };
  const current = lease?.environmentId === environmentId ? lease : undefined;
  if (current && current.text !== normalized) return { action: "blocked" };
  if (current) return { action: "send", key: current.key, lease: current };
  return { action: "send", key: newKey, lease: { environmentId, key: newKey, text: normalized } };
}
