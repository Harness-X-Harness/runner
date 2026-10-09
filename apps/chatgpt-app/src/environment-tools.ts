import { z } from "zod";
import { ToolV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { commandInput, agentInput } from "./environment-operation-service.ts";
import { openInput, environmentIdentity, ENVIRONMENT_SCOPE } from "./environment-service.ts";
import { inputResponse } from "./environment-task-input.ts";
import { launchesWorkbench } from "./workbench-routing.ts";
import { WORKBENCH_URI } from "./workbench-resource.ts";

export const inspectInput = environmentIdentity.extend({
  operationId: z.string().regex(/^task_[a-f0-9]{32}_(?:[a-f0-9]{32}|open|close)$/).optional(),
}).strict();

export const updateInput = z.object({
  operationId: z.string().regex(/^task_[a-f0-9]{32}_[a-f0-9]{32}$/),
  action: z.enum(["answer", "cancel"]),
  inputResponses: z.record(z.string(), inputResponse).optional(),
}).strict().refine(value => value.action === "answer"
  ? value.inputResponses !== undefined && Object.keys(value.inputResponses).length > 0
  : value.inputResponses === undefined, { message: "Answer requires inputResponses; cancel must omit them." });

export const environmentToolDefinitions = [
    { name: "agent", description: "Send a prompt in the Environment's workspace and native session. Inspect its reported model candidates first when choosing optional model/reasoningEffort. Omit both for defaults, or to reuse the first confirmed pair. A model alone uses its reported effort; an effort alone uses the deployment default model. A different pair after locking is rejected. Partial configuration failure disables agent work until a new Environment; command and close remain usable. Tasks clients receive standard Tasks. Other clients receive acceptance, not completion; inspect when asked and use update_operation to answer questions or cancel. Do not poll.", schema: agentInput },
    { name: "close_environment", description: "Stop the Environment. A Tasks client receives a Task until cleanup is confirmed. Without Tasks, the result can say closing; only status closed confirms cleanup. Cancelling the Task does not undo cleanup.", schema: environmentIdentity },
    { name: "command", description: "Execute literal argv in the Environment workspace, without invoking a model. The Environment must be ready. A Tasks client may receive a Task. Without Tasks, a committed result is returned directly; otherwise the result is an acceptance receipt with an operation ID. Inspect once when asked. Do not poll.", schema: commandInput },
    { name: "inspect_environment", description: "Read one owned Environment now: deadlines, current server-observed reconnect diagnostic and observation time when available, runner-reported model candidates and confirmed selection, active operation/questions, and the selected operation when operationId is set. Reconnect diagnostics are observations, not stop evidence or lifecycle authority; a successful ready generation clears them. Includes bounded output snapshots; replace earlier output, do not append or treat progress as final. Questions include their exact operationId and requestedSchema for update_operation. History does not hide active questions. Reported candidates are not native configuration confirmation. closing is not closed. Do not poll.", schema: inspectInput },
    { name: "list_environments", description: "Open the Workbench and find your live Environments, including opening, unavailable and closing. Returns owner-private IDs, executor, current lifecycle state and deadlines. Use this to recover an Environment from another client without creating work. Closed Environments are not listed; known retained results remain readable. A failed read is not an empty list. Inspect the selected ID for operations and questions. Do not poll.", schema: z.object({}).strict() },
    { name: "open_environment", description: "Open the Workbench and create a temporary Environment for the selected executor. Capacity rejection is a complete tool error for every client, with capacityKind and retryable. Owner capacity is non-retryable and reports the existing owned Environment; explicitly continue with or close it first. Global capacity is temporarily retryable. No rejection creates a Task, queues work or automatically retries. Do not poll. After admission, a Tasks client receives a Task until ready. Without Tasks, the result is the Environment ID and current status, such as opening, not proof that it is ready. Cancelling a pending open requests cleanup. Reuse an idempotencyKey when retrying uncertain creation.", schema: openInput },
    { name: "update_operation", description: "Answer outstanding questions or request cancellation of one command/agent operation without closing its Environment. Use the exact operationId and question IDs from inspect_environment. For answer, inputResponses maps each question ID to {action: accept, content: fields matching requestedSchema}, or {action: decline} / {action: cancel} to decline that question. For cancelling the entire operation, use action: cancel without inputResponses. Repeated answers keep the first accepted answer; late answers never restart finished work. Returns current state, not a promise of completed cancellation. Inspect once when asked; do not poll.", schema: updateInput },
  ];

export function environmentTools() {
  return environmentToolDefinitions.map(({ schema, ...tool }) => {
    const readOnly = tool.name === "inspect_environment" || tool.name === "list_environments";
    return ToolV2Schema.parse({ ...tool,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      _meta: { ui: { visibility: ["model", "app"],
        ...(launchesWorkbench(tool.name) ? { resourceUri: WORKBENCH_URI } : {}) } },
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && tool.name !== "open_environment",
        idempotentHint: readOnly || tool.name === "close_environment", openWorldHint: !readOnly },
      securitySchemes: [{ type: "oauth2", scopes: [ENVIRONMENT_SCOPE] }],
    });
  });
}
