import { selectedContext, type View } from "./view.ts";

type Context = NonNullable<ReturnType<typeof selectedContext>>;
export type ContextFeedback = "sent" | "unsupported" | "unavailable" | "failed" | "pending";

/** Suppress overlapping requests only. Every later explicit click may reassert selection.
 * A card cannot know which selection another card has sent to the host. */
export class ContextPublisher {
  private pending = false;

  async publish(view: View | undefined, supported: boolean,
    send: (context: Context) => Promise<object>): Promise<ContextFeedback> {
    const context = view && selectedContext(view);
    if (!context) return "unavailable";
    if (!supported) return "unsupported";
    if (this.pending) return "pending";
    this.pending = true;
    try {
      const response = await send(context);
      if ("isError" in response && response.isError === true) return "failed";
      return "sent";
    } catch { return "failed"; }
    finally { this.pending = false; }
  }
}
