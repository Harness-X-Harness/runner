import html from "../dist/workbench.ts";

export const WORKBENCH_URI = "ui://agentenv/workbench-v2.html";
export const workbenchResource = {
  uri: WORKBENCH_URI, name: "agentenv-workbench", title: "AgentEnv",
  description: "An on-demand view of your environments and operations.",
  mimeType: "text/html;profile=mcp-app",
};

export function readWorkbench() {
  return { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const,
    contents: [{ ...workbenchResource, text: html, _meta: { ui: {
      prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] },
    } } }],
  };
}

