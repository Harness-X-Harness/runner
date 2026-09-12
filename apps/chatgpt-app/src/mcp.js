import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { TASK_SECURITY_SCHEMES, registerTaskTools } from "./task-tools.js";

export function createServer(env, props) {
  const server = new McpServer(
    { name: "harness-x-harness", version: "1.0.0" },
    { instructions: "Use run_task for one autonomous code task, wait_task for its final response, and cancel_task to request a stop. Save the Task ID; do not automatically resubmit uncertain work." },
  );
  registerTaskTools(server, env, () => currentProps(props));
  return server;
}

export async function handleMcpRequest(request, env, props, ctx) {
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

function currentProps(fallback) {
  return getMcpAuthContext()?.props ?? fallback ?? {};
}

async function isToolsListRequest(request) {
  try {
    return (await request.clone().json())?.method === "tools/list";
  } catch {
    return false;
  }
}

async function addAppsSecuritySchemes(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json();
    return copyResponse(response, JSON.stringify(withAppsSecuritySchemes(body)));
  }
  if (contentType.includes("text/event-stream") && response.body) {
    const text = await new Response(response.body).text();
    const body = text.replace(/^data: (.+)$/gm, (line, data) => {
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

function copyResponse(response, body) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withAppsSecuritySchemes(body) {
  if (!body?.result?.tools) return body;
  return {
    ...body,
    result: {
      ...body.result,
      tools: body.result.tools.map((tool) => ({
        ...tool,
        securitySchemes: TASK_SECURITY_SCHEMES[tool.name],
      })),
    },
  };
}
