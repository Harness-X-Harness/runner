import { parentPort, workerData } from "node:worker_threads";
import { providerProcess } from "./provider-process.ts";
import { withAcpAgent } from "./acp-client.ts";
import { readFinalResponse } from "./final-response.ts";
import { TaskError } from "../../../shared/task-errors.ts";
import type { WorkerInput } from "./index.ts";

const input = workerData as WorkerInput;
const abort = new AbortController();
parentPort!.on("message", () => abort.abort(new TaskError("PROVIDER_EXECUTION_ERROR")));

async function run() {
  const env = input.env ?? process.env;
  let sessionId: string | undefined;
  const needsInput = async (): Promise<never> => {
    const error = new TaskError("USER_INPUT_REQUIRED");
    abort.abort(error);
    throw error;
  };
  return withAcpAgent({
    ...(input.agentProcess ?? providerProcess(input.executor, input.workingDirectory, env)),
    extensions: input.executor === "grok" ? "grok" : undefined,
    signal: abort.signal,
  }, {
    sessionUpdate: () => {}, // Final selection consumes only the SDK session queue.
    requestPermission: request => {
      const allowed = request.sessionId === sessionId && request.options.find(option =>
        option.kind === "allow_once" || option.kind === "allow_always");
      if (!allowed) {
        abort.abort(new TaskError("PROVIDER_PROTOCOL_ERROR"));
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: allowed.optionId } };
    },
    createElicitation: needsInput,
    grokQuestion: needsInput,
    grokExitPlan: async () => ({ outcome: "approved", feedback: null }),
  }, agent => agent.buildSession(input.workingDirectory).withSession(async session => {
    sessionId = session.sessionId;
    const pending = session.prompt(input.prompt);
    pending.catch(() => {});
    const finalResponse = await readFinalResponse(session, input.executor);
    await pending;
    return { finalResponse };
  }));
}

try {
  parentPort!.postMessage(await run());
} catch (error) {
  const failure = abort.signal.reason instanceof TaskError ? abort.signal.reason : error;
  const code = failure instanceof TaskError ? failure.code
    : failure instanceof Error && "code" in failure && failure.code === "ENOENT"
      ? "PROVIDER_UNAVAILABLE" : "PROVIDER_EXECUTION_ERROR";
  parentPort!.postMessage({ error: code });
} finally {
  parentPort!.close();
}
