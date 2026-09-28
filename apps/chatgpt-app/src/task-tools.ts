import { z } from "zod";
import { TASK_LIMITS } from "../../../shared/task-contract.ts";
import { TaskError } from "../../../shared/task-errors.ts";
import { cancelTask, waitTask, type TaskEnv } from "./task.ts";
import { taskSnapshotSchema, type TaskSnapshot } from "./task-request.ts";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";

const scheme = Object.freeze([{ type: "oauth2", scopes: ["tasks:manage"] }]);
export const TASK_SECURITY_SCHEMES = Object.freeze({ wait_task: scheme, cancel_task: scheme });

export function registerTaskTools(server: McpServer, env: TaskEnv, currentProps: () => unknown): void {
  const common = { outputSchema: taskSnapshotSchema, _meta: { securitySchemes: scheme } };
  server.registerTool("wait_task", {
      ...common, title: "Wait for a code task",
      description: "Read your Task's state and final response, waiting up to 25 seconds for change. A nonzero wait uses your current GitHub authority to observe an admitted run and reconcile a lost finish. Zero returns only the stored snapshot. No stream or automatic rerun.",
      inputSchema: z.object({ taskId: z.string(), timeoutSeconds: z.number().min(0).max(TASK_LIMITS.waitSeconds).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, invoke(waitTask));
  server.registerTool("cancel_task", {
      ...common, title: "Cancel a code task",
      description: "Request cancellation of your Task and its exact known GitHub run. Cancelling is not confirmation that the workflow has stopped; wait_task can confirm it later. A final response may win the race. Cancellation does not roll back earlier external changes.",
      inputSchema: z.object({ taskId: z.string() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, invoke(cancelTask));

  function invoke<Input>(handler: (env: TaskEnv, props: unknown, input: Input) => Promise<TaskSnapshot>) {
    return async (input: Input): Promise<CallToolResult> => {
      try {
        const task = await handler(env, currentProps(), input);
        return { structuredContent: task, content: [{ type: "text", text: JSON.stringify(task) }] };
      } catch (error) {
        const safe = error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR");
        return { isError: true, structuredContent: { error: safe.toJSON() },
          content: [{ type: "text", text: JSON.stringify({ error: safe.toJSON() }) }] };
      }
    };
  }
}
