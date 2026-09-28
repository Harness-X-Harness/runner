import type { AnyMessage, SessionNotification, Stream } from "@agentclientprotocol/sdk";
import { z } from "zod";

export const grokBoundary = z.object({
  sessionUpdate: z.enum(["response_started", "response_completed"]),
  stop_reason: z.string().nullish(),
});
const envelope = z.object({ sessionId: z.string(), update: z.object({ sessionUpdate: z.string() }).passthrough() });

// Preserve wire order before the SDK's ActiveSession queues updates and stop.
// No JSON-RPC framing, request matching, or custom message queue lives here.
export function normalizeGrokNotifications(stream: Stream): Stream {
  return { writable: stream.writable, readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      if (!("id" in message) && "method" in message &&
          ["_x.ai/session_notification", "_x.ai/session/update"].includes(message.method)) {
        const notification = envelope.parse(message.params);
        if (["response_started", "response_completed"].includes(notification.update.sessionUpdate)) {
          const params: SessionNotification = { sessionId: notification.sessionId, update: {
            sessionUpdate: "session_info_update",
            _meta: { "harness/grok-response": grokBoundary.parse(notification.update) },
          } };
          controller.enqueue({ jsonrpc: "2.0", method: "session/update", params });
          return;
        }
      }
      controller.enqueue(message);
    },
  })) };
}
