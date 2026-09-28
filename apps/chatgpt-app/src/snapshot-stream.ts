/** Internal SSE framing. Public MCP framing remains owned by the MCP SDK. */
export function snapshotStream<T>(observe: (signal: AbortSignal) => AsyncGenerator<T>): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const iterator = observe(abort.signal);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(item.value)}\n\n`));
      } catch (error) { abort.abort(); controller.error(error); }
    },
    async cancel() { abort.abort(); await iterator.return(undefined); },
  });
}
