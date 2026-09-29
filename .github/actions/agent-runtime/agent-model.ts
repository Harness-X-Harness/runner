import { z } from "zod";

export type AgentExecutor = "codex" | "grok";
export type AgentSelection = { model: string; reasoningEffort: string };
export type AgentModel = { id: string; effort: string; efforts: string[] };
export type AgentModelReport = { models: AgentModel[] };
export const AGENT_MODEL_DEFAULTS: Record<AgentExecutor, AgentSelection> = {
  codex: { model: "gpt-6-sol", reasoningEffort: "high" },
  grok: { model: "grok-4.7", reasoningEffort: "xhigh" },
};

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._~-]+$/);
const level = z.object({ effort: identifier }).passthrough();
const grokLevel = z.object({ value: identifier }).passthrough();

export function parseCodexModelReport(value: unknown): AgentModelReport {
  return parseReport(z.object({ models: z.array(z.object({
    slug: identifier, visibility: z.string(), default_reasoning_level: identifier,
    supported_reasoning_levels: z.array(level),
  }).passthrough()) }).passthrough().safeParse(value), parsed => parsed.models.flatMap(model =>
    model.visibility === "list" ? [reportedModel(model.slug, model.default_reasoning_level,
      model.supported_reasoning_levels.map(item => item.effort))] : []));
}

export function parseGrokModelReport(value: unknown): AgentModelReport {
  return parseReport(z.object({ data: z.array(z.object({
    id: identifier, reasoning_effort: identifier, reasoning_efforts: z.array(grokLevel),
  }).passthrough()) }).passthrough().safeParse(value), parsed => parsed.data.map(model =>
    reportedModel(model.id, model.reasoning_effort, model.reasoning_efforts.map(item => item.value))));
}

export function resolveAgentSelection(input: {
  executor: AgentExecutor;
  report: AgentModelReport;
  requested: { model?: string; reasoningEffort?: string };
  locked?: AgentSelection;
}): AgentSelection {
  if (input.locked && input.requested.model === undefined && input.requested.reasoningEffort === undefined) return input.locked;
  const fallback = input.locked ?? AGENT_MODEL_DEFAULTS[input.executor];
  const model = input.requested.model ?? fallback.model;
  const reported = input.report.models.find(item => item.id === model);
  const reasoningEffort = input.requested.model === undefined
    ? input.requested.reasoningEffort ?? fallback.reasoningEffort : input.requested.reasoningEffort ?? reported?.effort;
  if (!reported || reasoningEffort === undefined || !reported.efforts.includes(reasoningEffort)) throw new Error("AGENT_MODEL_REJECTED");
  if (input.locked && (input.locked.model !== model || input.locked.reasoningEffort !== reasoningEffort)) {
    throw new Error("AGENT_MODEL_CONFLICT");
  }
  return { model, reasoningEffort };
}

export async function readExecutorReport(executor: AgentExecutor, env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch, signal: AbortSignal): Promise<AgentModelReport> {
  const key = env.MINI_END_USER_KEY;
  const base = env[executor === "codex" ? "MINI_CODEX_BASE_URL" : "MINI_GROK_BASE_URL"];
  if (!key || !base) throw new Error("AGENT_MODEL_UNAVAILABLE");
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("AGENT_MODEL_UNAVAILABLE"); }
  if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error("AGENT_MODEL_UNAVAILABLE");
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  url.hash = "";
  url.search = executor === "codex" ? "?client_version=mini-live" : "";
  try {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal });
    if (!response.ok) throw new Error("AGENT_MODEL_UNAVAILABLE");
    return executor === "codex" ? parseCodexModelReport(await response.json()) : parseGrokModelReport(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_MODEL_UNAVAILABLE") throw error;
    throw new Error("AGENT_MODEL_UNAVAILABLE");
  }
}

export async function applyAgentSelection(current: AgentSelection, next: AgentSelection,
  setOption: (configId: "model" | "reasoning_effort", value: string) => Promise<void>): Promise<void> {
  if (current.model === next.model && current.reasoningEffort === next.reasoningEffort) return;
  if (current.model !== next.model) await setOption("model", next.model);
  await setOption("reasoning_effort", next.reasoningEffort);
}

function reportedModel(id: string, effort: string, efforts: string[]): AgentModel {
  if (!efforts.includes(effort)) throw new Error("AGENT_MODEL_UNAVAILABLE");
  return { id, effort, efforts };
}

function parseReport<T>(parsed: z.ZodSafeParseResult<T>, select: (value: T) => AgentModel[]): AgentModelReport {
  if (!parsed.success) throw new Error("AGENT_MODEL_UNAVAILABLE");
  const models = select(parsed.data);
  if (models.length === 0) throw new Error("AGENT_MODEL_UNAVAILABLE");
  return { models };
}
