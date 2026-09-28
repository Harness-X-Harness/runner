import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

// xai-org/grok-build: xai-grok-tools/src/mcp_elicitation/types.rs.
// This is an explicitly selected native extension, not a protocol fallback.
const envelope = z.object({
  sessionId: z.string(), toolCallId: z.string(), serverName: z.string(),
  message: z.string(), mode: z.literal("form"), requestedSchema: z.unknown(),
});

export function parseGrokForm(value: unknown): acp.CreateElicitationRequest {
  const request = envelope.parse(value) as acp.CreateElicitationRequest;
  if (!acp.CreateElicitationRequest.isForm(request)) throw new Error("Unsupported Grok form schema");
  return request;
}

export function grokAnswer(answer: acp.CreateElicitationResponse) {
  if (acp.CreateElicitationResponse.isAccept(answer)) return { outcome: "accept", content: answer.content };
  if (answer.action === "decline" || answer.action === "cancel") return { outcome: answer.action };
  throw new Error("Unsupported Grok answer");
}
