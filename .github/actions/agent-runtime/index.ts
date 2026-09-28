import { Worker } from "node:worker_threads";
import type { AgentProcess } from "./acp-client.ts";
import { TaskError } from "../../../shared/task-errors.ts";

export type Executor = "codex" | "grok";
export type RunInput = { prompt: string; workingDirectory: string };
export type RuntimeOptions = { env?: NodeJS.ProcessEnv; agentProcess?: Omit<AgentProcess, "signal"> };
export type WorkerInput = RunInput & RuntimeOptions & { executor: Executor };
type WorkerResult = { finalResponse: string } | { error: string };

// One-shot Task facade. The worker owns the scoped ACP connection; its output
// streams never reach Action logs, including diagnostics emitted by dependencies.
export class AgentRuntime {
  private readonly executor: Executor;
  private readonly options: RuntimeOptions;
  private worker?: Worker;
  private execution?: Promise<{ finalResponse: string }>;
  private closing?: Promise<void>;
  closed = false;

  constructor(executor: Executor, options: RuntimeOptions = {}) {
    if (executor !== "codex" && executor !== "grok") throw new TaskError("PROVIDER_UNAVAILABLE");
    this.executor = executor;
    this.options = options;
  }

  async run(input: RunInput): Promise<{ finalResponse: string }> {
    if (this.execution || this.closed || !input.prompt?.trim() || !input.workingDirectory) {
      throw new TaskError("PROVIDER_PROTOCOL_ERROR");
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { ...input, ...this.options, executor: this.executor } satisfies WorkerInput,
      env: this.options.env ?? process.env, stdout: true, stderr: true,
    });
    this.worker = worker;
    worker.stdout.resume();
    worker.stderr.resume();
    this.execution = new Promise((resolve, reject) => {
      let result: WorkerResult | undefined;
      worker.on("message", (message: WorkerResult) => { result = message; });
      worker.on("error", () => { result = { error: "PROVIDER_EXECUTION_ERROR" }; });
      worker.on("exit", code => {
        this.closed = true;
        if (code !== 0 || !result) return reject(new TaskError("PROVIDER_EXECUTION_ERROR"));
        if ("error" in result) return reject(new TaskError(result.error));
        resolve(result);
      });
    });
    return this.execution;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.worker?.postMessage("close");
    this.closing = (async () => {
      const timeout = setTimeout(() => { void this.worker?.terminate(); }, 4000);
      try { await this.execution?.catch(() => {}); }
      finally { clearTimeout(timeout); }
    })();
    return this.closing;
  }
}
