import { boundedOutput, emptyOutput, ENVIRONMENT_OUTPUT_BYTES, type OutputSnapshot } from "../../../shared/environment-output.ts";

/** Process-owned output receipts. The operation owner bounds their count. */
export class EnvironmentOutput {
  private readonly records = new Map<string, OutputSnapshot>();
  private readonly listeners = new Set<() => void>();

  begin(taskId: string): void {
    if (this.records.has(taskId)) throw new Error("OUTPUT_ALREADY_STARTED");
    this.records.set(taskId, emptyOutput());
  }

  append(taskId: string, text: string, truncated = false): void {
    const previous = this.records.get(taskId);
    if (!previous) throw new Error("OUTPUT_WITHOUT_OPERATION");
    if (previous.truncated) return;
    const remaining = ENVIRONMENT_OUTPUT_BYTES - Buffer.byteLength(previous.text);
    const prefix = boundedOutput(text, remaining);
    const next = { revision: previous.revision + 1, text: previous.text + prefix,
      truncated: previous.truncated || truncated || Buffer.byteLength(text) > remaining };
    if (next.text === previous.text && next.truncated === previous.truncated) return;
    this.records.set(taskId, next);
    for (const changed of this.listeners) changed();
  }

  read(taskId: string): OutputSnapshot {
    const record = this.records.get(taskId);
    if (!record) throw new Error("OUTPUT_NOT_FOUND");
    return { ...record };
  }

  entries(): Array<{ taskId: string; output: OutputSnapshot }> {
    return [...this.records].map(([taskId, output]) => ({ taskId, output: { ...output } }));
  }

  subscribe(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => { this.listeners.delete(changed); };
  }
}
