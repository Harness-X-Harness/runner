import { z } from "zod";
import { ToolV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { commandInput, agentInput } from "./environment-operation-service.ts";
import { openInput, environmentIdentity, ENVIRONMENT_SCOPE } from "./environment-service.ts";

export const inspectInput = environmentIdentity.extend({
  operationId: z.string().regex(/^task_[a-f0-9]{32}_(?:[a-f0-9]{32}|open|close)$/).optional(),
}).strict();

export const environmentToolDefinitions = [
    { name: "agent", description: "Send a prompt to the Environment's coding agent. Reuses its workspace and native session. Optional model and reasoningEffort must match that executor's current report. Omit both for the deployment default. A model alone uses that model's reported effort. An effort alone uses the deployment default model. The first call fixes the pair. A later call may omit both, but a different pair is rejected. The completed result reports the executor's current model and effort. If applying the selection fails or the executor reports a different pair, later agent calls fail until a new Environment is opened; command and close still work. A Tasks client may receive a Task that can require input. Without Tasks, the result is an acceptance receipt with an operation ID and current status, not completion. Waiting for input is not success, and that client cannot submit an answer. Inspect once when asked. Do not poll.", schema: agentInput },
    { name: "close_environment", description: "Stop the Environment. A Tasks client receives a Task until cleanup is confirmed. Without Tasks, the result can say closing; only status closed confirms cleanup. Cancelling the Task does not undo cleanup.", schema: environmentIdentity },
    { name: "command", description: "Execute literal argv in the Environment workspace, without invoking a model. The Environment must be ready. A Tasks client may receive a Task. Without Tasks, a committed result is returned directly; otherwise the result is an acceptance receipt with an operation ID. Inspect once when asked. Do not poll.", schema: commandInput },
    { name: "inspect_environment", description: "Read one owned Environment now. Returns its status, the active operation and its pending questions when one exists, and the selected operation when operationId is set. A selected operation does not hide the active operation. closing is not closed. Waiting for input is not success and cannot be answered here. Do not poll.", schema: inspectInput },
    { name: "open_environment", description: "Create a temporary Environment for the selected executor. A Tasks client receives a Task until ready. Without Tasks, the result is the Environment ID and current status, such as opening, not proof that it is ready. Cancelling a pending open requests cleanup. Reuse an idempotencyKey when retrying uncertain creation.", schema: openInput },
  ];

export function environmentTools() {
  return environmentToolDefinitions.map(({ schema, ...tool }) => {
    const readOnly = tool.name === "inspect_environment";
    return ToolV2Schema.parse({ ...tool,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && tool.name !== "open_environment",
        idempotentHint: readOnly || tool.name === "close_environment", openWorldHint: !readOnly },
      securitySchemes: [{ type: "oauth2", scopes: [ENVIRONMENT_SCOPE] }],
    });
  });
}
