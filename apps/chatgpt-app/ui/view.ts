import { z } from "zod";

// This is a display projection, never a lifecycle or authorization authority.
const environment = z.object({
  environmentId: z.string(), executor: z.string(), status: z.string(),
  expiresAt: z.number().nullable(), idleExpiresAt: z.number().nullable().optional(),
});
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
});
const listSchema = z.object({ environments: z.array(environment) });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Question = NonNullable<Snapshot["questions"]>[number];
export type Environment = z.infer<typeof environment>;
export type Result = { structuredContent?: unknown; content?: unknown; isError?: boolean };
export type View = { kind: "list"; environments: Environment[]; receivedAt: number }
  | { kind: "environment"; snapshot: Snapshot; receivedAt: number };

export function readView(result: Result, now: number): View {
  const snapshot = snapshotSchema.safeParse(result.structuredContent);
  if (snapshot.success) return { kind: "environment", snapshot: snapshot.data, receivedAt: now };
  if (result.isError) throw new Error(resultText(result) || "The request failed. No new state was confirmed.");
  const list = listSchema.safeParse(result.structuredContent);
  if (list.success) return { kind: "list", environments: list.data.environments, receivedAt: now };
  throw new Error("No environment snapshot was returned. Ask ChatGPT to inspect the environment.");
}

export function resultText(result: Result): string {
  const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).safeParse(result.content);
  return content.success ? content.data.flatMap(item => item.type === "text" && item.text ? [item.text] : []).join("\n") : "";
}

export function selectedContext(view: View) {
  if (view.kind === "list") return { content: [{ type: "text" as const,
    text: "AgentEnv workbench: no environment selected. Use list_environments to find live environments." }] };
  const s = view.snapshot;
  return { content: [{ type: "text" as const,
    text: `AgentEnv selection: environmentId=${s.environmentId}${s.operationId ? `, operationId=${s.operationId}` : ""}. Last viewed at ${new Date(view.receivedAt).toISOString()}: environment=${s.environmentStatus}${s.operationStatus ? `, operation=${s.operationStatus}` : ""}. This is a snapshot, not live state. Use this environment for the user's next request; do not open another environment or poll.`,
  }] };
}

export function refreshArguments(view: View) {
  if (view.kind === "list") return { name: "list_environments", arguments: {} };
  return { name: "inspect_environment", arguments: { environmentId: view.snapshot.environmentId,
    ...(view.snapshot.operationId ? { operationId: view.snapshot.operationId } : {}) } };
}

export function operationBusy(s: Snapshot) {
  return Boolean(s.activeOperationId) && !["completed", "failed", "cancelled"].includes(s.activeOperationStatus ?? "");
}

export function finalText(s: Snapshot): string | undefined {
  if (s.operationStatus !== "completed") return undefined;
  const agent = z.object({ finalResponse: z.string() }).safeParse(s.outcome);
  if (agent.success) return agent.data.finalResponse;
  const command = z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), truncated: z.boolean() }).safeParse(s.outcome);
  if (command.success) return `Exit code: ${command.data.exitCode ?? "none"}\n${command.data.stdout}${command.data.stderr ? `\n${command.data.stderr}` : ""}${command.data.truncated ? "\n[Output truncated]" : ""}`;
  return undefined;
}

export function stateLabel(s: Snapshot): string {
  if (s.environmentStatus !== "ready") return ({ opening: "Starting", closing: "Closing", closed: "Closed", unavailable: "Disconnected" })[s.environmentStatus] ?? s.environmentStatus;
  if (s.questions?.length) return "Needs your answer";
  if (operationBusy(s)) return "Working";
  return ({ completed: "Completed", failed: "Failed", cancelled: "Cancelled" })[s.operationStatus ?? ""] ?? "Ready";
}

export function replyMessage(s: Snapshot, action: "explain" | "continue" | "answer") {
  const operationId = action === "answer" ? s.questions?.[0]?.operationId : s.operationId;
  const target = `environmentId=${s.environmentId}${operationId ? `, operationId=${operationId}` : ""}`;
  const intent = action === "explain" ? "Explain the selected operation's result. Do not execute new work."
    : action === "answer" ? "Help me answer the current operation's pending questions using update_operation. Do not create a new agent turn."
    : "Continue our task in this existing environment. If there is no clear next instruction, ask me what to do next. Do not create another environment.";
  return { role: "user" as const, content: [{ type: "text" as const, text: `AgentEnv: ${target}. ${intent} Read its current snapshot once if needed; do not poll.` }] };
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
  if (!fields || !question.requestedSchema) throw new Error("Use ChatGPT to answer this question.");
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
