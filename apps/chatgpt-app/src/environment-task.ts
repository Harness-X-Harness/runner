import { DetailedTaskV2Schema, type DetailedTaskV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import { z } from "zod";
import type { OperationRecord } from "./environment-object.ts";

const outcome = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ok: z.literal(false), code: z.string().regex(/^[A-Z_]{1,64}$/) }).strict(),
]);
const commandResult = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  stdout: z.string(), stderr: z.string(), truncated: z.boolean(),
  stopReason: z.enum(["cancelled", "timeout"]).optional() }).strict();
const agentResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), finalResponse: z.string(),
    model: z.string().min(1).max(200).optional(), reasoningEffort: z.string().min(1).max(32).optional() }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);

/** Pure wire projection. Durable operation records remain the only Task state. */
export function environmentTask(taskId: string, record: OperationRecord): DetailedTaskV2 {
  const base = { taskId, createdAt: new Date(record.createdAt).toISOString(),
    lastUpdatedAt: new Date(record.updatedAt).toISOString(),
    // The shared retention deadline is fixed when the Environment closes.
    ttlMs: record.expiresAt === undefined ? null : record.expiresAt - record.createdAt };
  if (record.result === undefined) {
    const inputRequests = Object.fromEntries(Object.entries(record.inputs ?? {})
      .filter(([, input]) => input.response === undefined).map(([id, input]) => [id, input.request]));
    return DetailedTaskV2Schema.parse({ ...base, ...(Object.keys(inputRequests).length && !record.cancelRequested
      ? { status: "input_required", inputRequests } : { status: "working" }) });
  }
  const result = outcome.parse(record.result);
  if (!result.ok) return DetailedTaskV2Schema.parse({ ...base, status: "failed",
    error: { code: -32603, message: result.code === "ENVIRONMENT_ENDED_OUTCOME_UNKNOWN"
      ? "The environment ended before the execution result was confirmed. Effects may have occurred; do not automatically retry."
      : result.code } });
  const { kind } = z.object({ kind: z.enum(["command", "agent"]) }).parse(JSON.parse(record.request));
  let text: string;
  let isError = false;
  if (kind === "command") {
    const value = commandResult.parse(result.value);
    if (value.stopReason === "cancelled") return DetailedTaskV2Schema.parse({ ...base, status: "cancelled" });
    isError = value.exitCode !== 0 || value.signal !== null || value.stopReason === "timeout";
    text = JSON.stringify(value);
  } else {
    const value = agentResult.parse(result.value);
    if (value.status === "cancelled") return DetailedTaskV2Schema.parse({ ...base, status: "cancelled" });
    text = value.finalResponse;
  }
  return DetailedTaskV2Schema.parse({ ...base, status: "completed", result: {
    resultType: "complete", content: [{ type: "text", text }],
    structuredContent: result.value, isError,
  } });
}
