import { z } from "zod";
import { TASK_LIMITS } from "../../../shared/task-contract.js";
import { TaskError } from "../../../shared/task-errors.js";
import { cancelTask, runTask, waitTask } from "./task.js";

const scheme = Object.freeze([{ type: "oauth2", scopes: ["tasks:manage"] }]);
export const TASK_SECURITY_SCHEMES = Object.freeze({ run_task: scheme, wait_task: scheme, cancel_task: scheme });

const snapshot = z.object({
  taskId: z.string(), executor: z.enum(["codex", "grok"]),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  createdAt: z.string(), updatedAt: z.string(), finishedAt: z.string().optional(), runUrl: z.string().optional(),
  result: z.object({ finalResponse: z.string(), truncated: z.boolean().optional() }).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
});

export function registerTaskTools(server, env, currentProps) {
  const definitions = [
    { name: "run_task", title: "Run a code task",
      description: "Run one autonomous Codex or Grok task in a temporary runner with the platform's GitHub credentials. Put repository and desired work in the prompt. This can change repositories and other external state. Returns a Task ID; use wait_task even if startup is uncertain. Do not automatically resubmit.",
      inputSchema: z.object({ executor: z.enum(["codex", "grok"]), prompt: z.string().min(1).max(TASK_LIMITS.promptBytes) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      invoke: runTask },
    { name: "wait_task", title: "Wait for a code task",
      description: "Read your Task's state and final response, waiting up to 25 seconds for change. A nonzero wait uses your current GitHub authority to observe an admitted run and reconcile a lost finish. Zero returns only the stored snapshot. No stream or automatic rerun.",
      inputSchema: z.object({ taskId: z.string(), timeoutSeconds: z.number().min(0).max(TASK_LIMITS.waitSeconds).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      invoke: waitTask },
    { name: "cancel_task", title: "Cancel a code task",
      description: "Request cancellation of your Task and its exact known GitHub run. Cancelling is not confirmation that the workflow has stopped; wait_task can confirm it later. A final response may win the race. Cancellation does not roll back earlier external changes.",
      inputSchema: z.object({ taskId: z.string() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      invoke: cancelTask },
  ];
  for (const { name, invoke, ...definition } of definitions) {
    server.registerTool(name, {
      ...definition, outputSchema: snapshot, _meta: { securitySchemes: TASK_SECURITY_SCHEMES[name] },
    }, async (input) => {
      try {
        const task = await invoke(env, currentProps(), input);
        return { structuredContent: task, content: [{ type: "text", text: JSON.stringify(task) }] };
      } catch (error) {
        const safe = error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR");
        return { isError: true, structuredContent: { error: safe.toJSON() },
          content: [{ type: "text", text: JSON.stringify({ error: safe.toJSON() }) }] };
      }
    });
  }
}
