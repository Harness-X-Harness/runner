import { selectedContext, type View } from "./view.ts";

type Context = NonNullable<ReturnType<typeof selectedContext>>;
export type ContextFeedback = "sent" | "duplicate" | "unsupported" | "unavailable" | "failed" | "pending";

/** Per-card acknowledgements only. The host offers no conversation-wide ordering. */
export class ContextPublisher {
  private acknowledged?: string;
  private pending = false;

  async publish(view: View | undefined, supported: boolean,
    send: (context: Context) => Promise<object>): Promise<ContextFeedback> {
    const context = view && selectedContext(view);
    if (!context) return "unavailable";
    if (!supported) return "unsupported";
    if (this.pending) return "pending";
    const environmentId = view!.kind === "environment" ? view!.snapshot.environmentId : undefined;
    if (this.acknowledged === environmentId) return "duplicate";
    this.pending = true;
    try {
      const response = await send(context);
      if ("isError" in response && response.isError === true) return "failed";
      this.acknowledged = environmentId;
      return "sent";
    } catch { return "failed"; }
    finally { this.pending = false; }
  }
}
