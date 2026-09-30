import { Container } from "@cloudflare/containers";
import type { WebhookDelivery, WebhookDeliveryResult } from "../../../shared/webhook-delivery.ts";

/** Private transport adapter. It has no subscriptions or execution authority. */
export class EventDeliveryContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = true;
  pingEndpoint = "localhost/health";

  async deliver(input: WebhookDelivery): Promise<WebhookDeliveryResult> {
    try {
      const response = await this.containerFetch("http://container/deliver", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { kind: "error", reason: "network" };
      return await response.json<WebhookDeliveryResult>();
    } catch { return { kind: "error", reason: "network" }; }
  }
}
