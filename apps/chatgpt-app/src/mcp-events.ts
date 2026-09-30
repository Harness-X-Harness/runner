// MCP Events draft webhook subset, as supported by OpenAI. The SDK does not
// yet model these methods; keep this extension at the existing MCP boundary.
import { z } from "zod";

export const EVENT_NAME = "environment.updated";
const argumentsSchema = z.object({ environmentId: z.string().regex(/^env_[a-f0-9]{32}$/) }).strict();
const urlSchema = z.string().max(4096).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      (!url.port || url.port === "443") && url.hostname.includes(".");
  } catch { return false; }
});
const secretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/).refine(value => {
  try { const decoded = atob(value.slice(6)); return decoded.length >= 24 && decoded.length <= 64 && btoa(decoded) === value.slice(6); }
  catch { return false; }
});
const delivery = z.object({ mode: z.literal("webhook"), url: urlSchema }).strict();
const base = { name: z.string(), arguments: argumentsSchema, _meta: z.record(z.string(), z.unknown()).optional() };
const subscribe = z.object({ ...base, delivery: delivery.extend({ secret: secretSchema }),
  cursor: z.null().optional(), ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict();
const unsubscribe = z.object({ ...base, delivery }).strict();
const envelope = { jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]) };
export const eventRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...envelope, method: z.literal("events/list"), params: z.object({
    cursor: z.string().optional(), _meta: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional() }),
  z.object({ ...envelope, method: z.literal("events/subscribe"), params: subscribe }),
  z.object({ ...envelope, method: z.literal("events/unsubscribe"), params: unsubscribe }),
]);
export type EventRequest = z.infer<typeof eventRequestSchema>;
export type SubscribeInput = z.infer<typeof subscribe>;
export type UnsubscribeInput = z.infer<typeof unsubscribe>;
export const grantIdentity = z.object({ userId: z.string().min(1), grantId: z.string().min(1), clientId: z.string().min(1) }).strict();
export type GrantIdentity = z.infer<typeof grantIdentity>;
const eventData = z.discriminatedUnion("kind", [
  argumentsSchema.extend({ revision: z.number().int().positive(), kind: z.literal("environment"),
    status: z.enum(["opening", "ready", "unavailable", "closing", "closed"]) }),
  argumentsSchema.extend({ revision: z.number().int().positive(), kind: z.literal("operation"),
    operationId: z.string().regex(/^[\w-]{1,128}$/), status: z.enum(["input_required", "completed", "failed", "cancelled"]) }),
]);
export type EventData = z.infer<typeof eventData>;
export type EventChange = Omit<Extract<EventData, { kind: "environment" }>, "environmentId" | "revision"> |
  Omit<Extract<EventData, { kind: "operation" }>, "environmentId" | "revision">;
export const eventCatalog = { events: [{ name: EVENT_NAME,
  description: "Significant lifecycle changes in one owned Environment: ready, closed, operation input required or terminal. A new subscription gets the latest state. Read inspect_environment for current details; notifications contain no output or credentials. No replay or token stream.",
  delivery: ["webhook"], inputSchema: z.toJSONSchema(argumentsSchema), payloadSchema: z.toJSONSchema(eventData),
}] };
export class EventError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message); this.code = code; this.data = data;
  }
}
export type EventRpcReply = { ok: true; value: Record<string, unknown> } |
  { ok: false; error: { code: number; message: string; data?: Record<string, unknown> } };
/** RPC preserves data, not a custom Error's prototype. Carry expected failures as data. */
export async function eventRpc(action: () => Promise<Record<string, unknown>>): Promise<EventRpcReply> {
  try { return { ok: true, value: await action() }; }
  catch (error) {
    if (!(error instanceof EventError)) throw error;
    return { ok: false, error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } };
  }
}
export function eventRpcValue(reply: EventRpcReply): Record<string, unknown> {
  if (!reply.ok) throw new EventError(reply.error.code, reply.error.message, reply.error.data);
  return reply.value;
}
export interface EventAuthority { handle(request: EventRequest): Promise<Record<string, unknown>> }
