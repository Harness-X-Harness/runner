import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { TASK_SECURITY_SCHEMES, registerTaskTools } from "./task-tools.ts";
import type { TaskEnv } from "./task.ts";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { z } from "zod";

export function createServer(env: TaskEnv, props: Record<string, unknown> = {}): McpServer {
  const server = new McpServer(
    { name: "harness-x-harness", version: "1.0.0" },
    { instructions: "Use run_task for one autonomous code task, wait_task for its final response, and cancel_task to request a stop. Save the Task ID; do not automatically resubmit uncertain work." },
  );
  registerTaskTools(server, env, () => currentProps(props));
  return server;
}

export async function handleMcpRequest(request: Request, env: TaskEnv, props: Record<string, unknown> | undefined, ctx: ExecutionContext): Promise<Response> {
  const toolsListRequest = request.method === "POST" && await isToolsListRequest(request);
  const handler = createMcpHandler(() => createServer(env, currentProps(props)), {
    route: "/mcp",
    authContext: { props: props ?? {} },
  });
  const response = await handler(request, env, ctx);
  return toolsListRequest
    ? addAppsSecuritySchemes(response)
    : response;
}

function currentProps(fallback?: Record<string, unknown>): Record<string, unknown> {
  return getMcpAuthContext()?.props ?? fallback ?? {};
}

async function isToolsListRequest(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    return Boolean(body && typeof body === "object" && "method" in body && body.method === "tools/list");
  } catch {
    return false;
  }
}

async function addAppsSecuritySchemes(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json();
    return copyResponse(response, JSON.stringify(withAppsSecuritySchemes(body)));
  }
  if (contentType.includes("text/event-stream") && response.body) {
    const text = await new Response(response.body).text();
    const body = text.replace(/^data: (.+)$/gm, (line: string, data: string) => {
      try {
        return `data: ${JSON.stringify(withAppsSecuritySchemes(JSON.parse(data)))}`;
      } catch {
        return line;
      }
    });
    return copyResponse(response, body);
  }
  return response;
}

function copyResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const toolListSchema = z.looseObject({ result: z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })) }) });

function withAppsSecuritySchemes(body: unknown): unknown {
  const parsed = toolListSchema.safeParse(body);
  if (!parsed.success) return body;
  const envelope = parsed.data;
  return {
    ...envelope,
    result: {
      ...envelope.result,
      tools: envelope.result.tools.map((tool) => ({
        ...tool,
        securitySchemes: Object.hasOwn(TASK_SECURITY_SCHEMES, tool.name)
          ? TASK_SECURITY_SCHEMES[tool.name as keyof typeof TASK_SECURITY_SCHEMES] : undefined,
      })),
    },
  };
}
