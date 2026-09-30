/** Internal delivery result, not an MCP result or business-state authority. */
export type WebhookDelivery = {
  url: string;
  body: string;
  headers: {
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
    "x-mcp-subscription-id": string;
  };
};
export type WebhookDeliveryResult =
  | { kind: "response"; status: number; body: string }
  | { kind: "error"; reason: "invalid_request" | "invalid_destination" | "timeout" | "network" | "response_too_large" };
