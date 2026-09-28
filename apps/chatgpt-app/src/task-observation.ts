import { DetailedTaskV2Schema, type DetailedTaskV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

export interface ObservationSource<T> {
  // Register synchronously at the same authority that owns read().
  // Notifications mean "read again", not a second copy of Task state.
  subscribe(changed: () => void): () => void;
  // The authority checks owner/scope on every read and respects abort.
  read(signal: AbortSignal): Promise<T>;
}
export type TaskObservationSource = ObservationSource<unknown>;

export async function* observeTask(
  source: TaskObservationSource, signal: AbortSignal,
): AsyncGenerator<DetailedTaskV2> {
  for await (const snapshot of observeSnapshots(source, signal)) yield DetailedTaskV2Schema.parse(snapshot);
}

export async function* observeSnapshots<T>(source: ObservationSource<T>, signal: AbortSignal): AsyncGenerator<T> {
  if (signal.aborted) return;
  let dirty = true;
  let wake: (() => void) | undefined;
  let detached = false;
  const unsubscribe = source.subscribe(() => { dirty = true; wake?.(); });
  const detach = () => {
    if (!detached) {
      detached = true;
      unsubscribe();
    }
    wake?.();
  };
  signal.addEventListener('abort', detach, { once: true });
  try {
    while (!signal.aborted) {
      if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      if (signal.aborted) return;
      dirty = false;
      const snapshot = await source.read(signal);
      if (signal.aborted) return;
      yield snapshot;
    }
  } finally {
    signal.removeEventListener('abort', detach);
    detach();
  }
}
