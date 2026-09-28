import { EventSourceParserStream } from "eventsource-parser/stream";

/** Internal SSE only. Check current authority before each public delivery. */
export function authorizedSnapshots<T>(stream: ReadableStream<Uint8Array>, signal: AbortSignal,
  check: () => Promise<void>, parse: (value: unknown) => T): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  const reader = stream.pipeThrough(new TransformStream<Uint8Array, string>({
    transform(chunk, controller) { controller.enqueue(decoder.decode(chunk, { stream: true })); },
    flush(controller) { controller.enqueue(decoder.decode()); },
  })).pipeThrough(new EventSourceParserStream({ onError: "terminate", maxBufferSize: 1024 * 1024 })).getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= reader.cancel();
  const stop = () => { void cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return (async function* () {
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done || signal.aborted) return;
        await check();
        signal.throwIfAborted();
        yield parse(JSON.parse(next.value.data));
      }
    } finally {
      signal.removeEventListener("abort", stop);
      await cancel();
      reader.releaseLock();
    }
  })();
}
