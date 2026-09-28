import { DetailedTaskV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { environmentUri } from "./environment-resources.ts";

export type LifecycleKind = "open" | "close";
export type LifecycleReceipt = {
  createdAt: number;
  updatedAt: number;
  status: "working" | "completed" | "failed" | "cancelled";
  cancelRequested?: true;
};

export function lifecycleTaskId(environmentId: string, kind: LifecycleKind): string {
  return `task_${environmentId.slice(4)}_${kind}`;
}

export function lifecycleIdentity(taskId: string): { environmentId: string; kind: LifecycleKind } | undefined {
  const match = /^task_([a-f0-9]{32})_(open|close)$/.exec(taskId);
  if (!match) return undefined;
  return { environmentId: `env_${match[1]}`, kind: match[2] === "open" ? "open" : "close" };
}

/** A terminal receipt describes an operation, not the current connection state. */
export function lifecycleTask(environmentId: string, kind: LifecycleKind,
  receipt: LifecycleReceipt, expiresAt?: number) {
  const base = { taskId: lifecycleTaskId(environmentId, kind), status: receipt.status,
    createdAt: new Date(receipt.createdAt).toISOString(),
    lastUpdatedAt: new Date(receipt.updatedAt).toISOString(),
    ttlMs: expiresAt === undefined ? null : expiresAt - receipt.createdAt };
  if (receipt.status === "completed") return DetailedTaskV2Schema.parse({ ...base, result: {
    resultType: "complete", content: [{ type: "resource_link", name: environmentId,
      uri: environmentUri(environmentId), mimeType: "application/json" }],
    structuredContent: { environmentId, outcome: kind === "open" ? "opened" : "closed" },
  } });
  if (receipt.status === "failed") return DetailedTaskV2Schema.parse({ ...base,
    error: { code: -32603, message: "The environment ended before it became ready." } });
  return DetailedTaskV2Schema.parse(base);
}
