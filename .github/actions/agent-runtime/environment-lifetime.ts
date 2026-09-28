/** Runner-local lifetime. A resolved shutdown is not GitHub stop evidence. */
export class EnvironmentLifetime {
  private readonly controller = new AbortController();
  private readonly completion = Promise.withResolvers<void>();
  private readonly shutdown: () => Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  readonly stopped = this.completion.promise;
  readonly signal = this.controller.signal;

  constructor(deadline: number, shutdown: () => Promise<void>) {
    const remaining = deadline - Date.now();
    if (!Number.isSafeInteger(deadline) || remaining > 2_147_483_647) {
      throw new Error("INVALID_ENVIRONMENT_DEADLINE");
    }
    this.shutdown = shutdown;
    // The owner awaits stopped; attaching a handler avoids an unhandled rejection
    // if a deadline races with startup. The original promise still rejects.
    void this.stopped.catch(() => {});
    if (remaining <= 0) this.close();
    else this.timer = setTimeout(() => { this.close(); }, remaining);
  }

  close(): Promise<void> {
    if (this.signal.aborted) return this.stopped;
    clearTimeout(this.timer);
    this.controller.abort();
    // Run after synchronous admission sealing. Propagate cleanup failure rather
    // than turning intent or an elapsed timer into confirmed completion.
    Promise.resolve().then(this.shutdown).then(this.completion.resolve, this.completion.reject);
    return this.stopped;
  }
}
