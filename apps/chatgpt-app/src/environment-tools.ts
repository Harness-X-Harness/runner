import { z } from "zod";
import { ToolV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { commandInput, agentInput } from "./environment-operation-service.ts";
import { openInput, environmentIdentity, ENVIRONMENT_SCOPE } from "./environment-service.ts";

export const environmentToolDefinitions = [
    { name: "agent", description: "Send a prompt to the Environment's coding agent. Reuses its workspace and native session. May return a Task requiring user input.", schema: agentInput },
    { name: "close_environment", description: "Stop the Environment. Returns a Task until cleanup is confirmed. Cancelling this Task does not undo cleanup.", schema: environmentIdentity },
    { name: "command", description: "Execute literal argv in the Environment workspace, without invoking a model. The Environment must be ready. May return a Task.", schema: commandInput },
    { name: "open_environment", description: "Create a temporary Environment for the selected executor. Returns a Task until ready; cancelling a pending open requests cleanup. Reuse an idempotencyKey when retrying uncertain creation.", schema: openInput },
  ];

export function environmentTools() {
  return environmentToolDefinitions.map(({ schema, ...tool }) => ToolV2Schema.parse({ ...tool,
    inputSchema: z.toJSONSchema(schema, { io: "input" }),
    annotations: { readOnlyHint: false, destructiveHint: tool.name !== "open_environment",
      idempotentHint: tool.name === "close_environment", openWorldHint: true },
    securitySchemes: [{ type: "oauth2", scopes: [ENVIRONMENT_SCOPE] }],
  }));
}
