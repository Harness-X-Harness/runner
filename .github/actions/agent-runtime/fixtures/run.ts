import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../index.ts";
import { TaskError } from "../../../../shared/task-errors.ts";

const runtime = new AgentRuntime("grok", { env: {}, agentProcess: {
  command: process.execPath, args: [fileURLToPath(new URL("./agent.ts", import.meta.url))],
  workspace: process.cwd(), env: {},
} });
try { console.log(JSON.stringify(await runtime.run({ prompt: "malformed", workingDirectory: process.cwd() }))); }
catch (error) { console.log(JSON.stringify(error instanceof TaskError ? error.toJSON() : { code: "INTERNAL_ERROR" })); }
