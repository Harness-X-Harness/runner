import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

export type PendingInput = { taskId: string; inputId: string;
  request: { method: "elicitation/create"; params: { mode: "form"; message: string; requestedSchema: unknown } } };
type Receipt = { input: PendingInput; schema: z.ZodType; response?: acp.CreateElicitationResponse;
  resolve: (response: acp.CreateElicitationResponse) => void };

/** Native requests live with the runtime, never with a replaceable socket. */
export class EnvironmentInput {
  private readonly receipts = new Map<string, Receipt>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify() { for (const listener of this.listeners) listener(); }

  request(taskId: string, value: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    if (!/^[\w-]{1,128}$/.test(taskId) || !acp.CreateElicitationRequest.isForm(value)) {
      throw new Error("INVALID_INPUT_REQUEST");
    }
    const input: PendingInput = { taskId, inputId: randomUUID(), request: { method: "elicitation/create",
      params: { mode: "form", message: value.message, requestedSchema: structuredClone(value.requestedSchema) } } };
    if (Buffer.byteLength(JSON.stringify(input)) > 65536 || this.receipts.size >= 256) throw new Error("INPUT_CAPACITY_EXCEEDED");
    // ACP permits future schema variants; the standard converter rejects unsupported ones.
    const schema = z.fromJSONSchema(value.requestedSchema as Parameters<typeof z.fromJSONSchema>[0]);
    const result = Promise.withResolvers<acp.CreateElicitationResponse>();
    this.receipts.set(input.inputId, { input, schema, resolve: result.resolve });
    this.notify();
    return result.promise;
  }

  pending(taskId?: string): PendingInput[] {
    return [...this.receipts.values()].filter(record => (taskId === undefined || record.input.taskId === taskId) && record.response === undefined)
      .map(record => structuredClone(record.input));
  }

  answer(taskId: string, inputId: string, value: unknown): void {
    const record = this.receipts.get(inputId);
    if (!record || record.input.taskId !== taskId) throw new Error("INPUT_NOT_FOUND");
    const candidate = value as acp.CreateElicitationResponse;
    let response: acp.CreateElicitationResponse;
    if (acp.CreateElicitationResponse.isAccept(candidate)) {
      response = { action: "accept", content: record.schema.parse(candidate.content) };
    } else if (acp.CreateElicitationResponse.isDecline(candidate)) response = { action: "decline" };
    else if (acp.CreateElicitationResponse.isCancel(candidate)) response = { action: "cancel" };
    else throw new Error("INVALID_INPUT_RESPONSE");
    if (record.response !== undefined) {
      if (JSON.stringify(record.response) !== JSON.stringify(response)) throw new Error("INPUT_RESPONSE_CONFLICT");
      return;
    }
    record.response = structuredClone(response);
    record.resolve(structuredClone(response));
    this.notify();
  }

  cancel(taskId: string): void {
    for (const input of this.pending(taskId)) this.answer(taskId, input.inputId, { action: "cancel" });
  }
}
