import { CallToolResultV2Schema, type CallToolResultV2, type DetailedTaskV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import { z } from "zod";
import type { EnvironmentSnapshot } from "./environment-object.ts";

export type OrdinaryTool = "agent" | "close_environment" | "command" | "inspect_environment" | "open_environment";
export type OrdinaryDispatch = "accepted" | "unknown" | "rejected" | "already-issued";
export type OrdinaryView = {
  tool: OrdinaryTool;
  environment: EnvironmentSnapshot;
  operation?: DetailedTaskV2;
  /** Present only when this active operation is not `operation`. */
  activeOperation?: DetailedTaskV2;
  activeUnreadable?: boolean;
  historical?: boolean;
  dispatch?: OrdinaryDispatch;
};
type Assessment = {
  workFinished: boolean;
  disposition: "accepted" | "ready" | "closed" | "closing" | "waiting_for_input" | "failed" | "cancelled" | "unavailable" | "result";
  isError: boolean;
};
const completedResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/** Tool error visible to the model. It is not a Task handle and not a retry. */
export function ordinaryError(text: string): CallToolResultV2 {
  return CallToolResultV2Schema.parse({ resultType: "complete", isError: true,
    content: [{ type: "text", text }] });
}

/** One honest snapshot. Acceptance is not completion, and closing is not closed. */
export function ordinaryToolResult(view: OrdinaryView): CallToolResultV2 {
  const selected = operationFacts(view.operation);
  const active = view.activeOperation ? operationFacts(view.activeOperation) : undefined;
  const facts = { ...selected, questions: active?.questions.length ? active.questions : selected.questions };
  const assessment = assess(view, selected.commandError);
  const content: { type: "text"; text: string }[] = [{ type: "text", text: describe(view, assessment, facts) }];
  if (selected.resultText) content.push({ type: "text", text: selected.resultText });
  return CallToolResultV2Schema.parse({ resultType: "complete",
    ...(assessment.isError ? { isError: true } : {}), content,
    structuredContent: defined({ contract: "ordinary", tool: view.tool,
      workFinished: assessment.workFinished, disposition: assessment.disposition,
      environmentId: view.environment.environmentId, environmentStatus: view.environment.status,
      environmentReason: view.environment.reason, activeOperationId: view.environment.activeTaskId,
      activeOperationStatus: view.activeOperation?.status
        ?? (view.operation && view.environment.activeTaskId === view.operation.taskId ? view.operation.status : undefined),
      operationId: view.operation?.taskId, operationStatus: view.operation?.status,
      historical: view.historical === true ? true : undefined, dispatch: view.dispatch,
      questions: facts.questions.length ? facts.questions : undefined, outcome: facts.outcome,
    }) });
}

function assess(view: OrdinaryView, commandError: boolean): Assessment {
  const selected = assessSelected(view, commandError);
  if (view.activeUnreadable || view.activeOperation?.status === "working") return { ...selected, workFinished: false };
  if (view.activeOperation?.status === "input_required") {
    return { workFinished: false, disposition: "waiting_for_input", isError: selected.isError };
  }
  return selected;
}

function assessSelected(view: OrdinaryView, commandError: boolean): Assessment {
  const status = view.environment.status;
  const operation = view.operation?.status;
  if (operation === "input_required") return { workFinished: false, disposition: "waiting_for_input", isError: false };
  if (operation === "cancelled") return { workFinished: true, disposition: "cancelled", isError: true };
  if (operation === "failed" || view.dispatch === "rejected") {
    const terminal = operation === "failed" || operation === "completed" || status === "closed";
    return { workFinished: terminal, disposition: "failed", isError: true };
  }
  const lifecycle = lifecycleKind(view);
  if (lifecycle === "open") {
    if (status === "ready") return { workFinished: true, disposition: "ready", isError: false };
    return { workFinished: false, disposition: status === "unavailable" ? "unavailable"
      : status === "closing" ? "closing" : status === "closed" ? "closed" : "accepted", isError: false };
  }
  if (lifecycle === "close") {
    if (status === "closed") return { workFinished: true, disposition: "closed", isError: false };
    return { workFinished: false, disposition: status === "closing" ? "closing"
      : status === "unavailable" ? "unavailable" : "accepted", isError: false };
  }
  if (operation === "completed") return { workFinished: true, disposition: "result", isError: commandError };
  if (operation === "working") return { workFinished: false, disposition: status === "closing" ? "closing"
    : status === "unavailable" ? "unavailable" : "accepted", isError: false };
  if (status === "closed") return { workFinished: true, disposition: "closed", isError: false };
  if (status === "closing") return { workFinished: false, disposition: "closing", isError: false };
  if (status === "unavailable") return { workFinished: false, disposition: "unavailable", isError: false };
  if (status === "ready") return { workFinished: false, disposition: "ready", isError: false };
  return { workFinished: false, disposition: "accepted", isError: false };
}

function operationFacts(task: DetailedTaskV2 | undefined) {
  const empty = { questions: [] as { id: string; message: string }[], commandError: false,
    resultText: undefined as string | undefined, outcome: undefined as unknown };
  if (!task) return empty;
  if (task.status === "input_required") return { ...empty, questions: Object.entries(task.inputRequests).map(([id, request]) => ({
    id, message: request.method === "elicitation/create" && typeof request.params.message === "string"
      ? request.params.message : "Input requested.",
  })) };
  if (task.status === "failed") return { ...empty, outcome: { message: task.error.message } };
  if (task.status !== "completed") return empty;
  const parsed = completedResult.safeParse(task.result);
  if (!parsed.success) return empty;
  const resultText = parsed.data.content?.flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n");
  return { ...empty, resultText: resultText || undefined, outcome: parsed.data.structuredContent,
    commandError: parsed.data.isError === true };
}

function describe(view: OrdinaryView, assessment: Assessment, facts: ReturnType<typeof operationFacts>): string {
  const environment = view.environment;
  const reason = environment.reason ? ` (${environment.reason})` : "";
  const parts = [`Ordinary result for ${view.tool}.`,
    `Environment ${environment.environmentId} is ${environment.status}${reason}.`];
  if (view.dispatch) parts.push(`Dispatch is ${view.dispatch}.`);
  if (view.operation) {
    parts.push(`Operation ${view.operation.taskId} is ${view.operation.status}.`);
    if (view.historical) parts.push("This operation is not the active operation.");
    if (lifecycleKind(view) === "open" && view.operation.status === "completed" && environment.status !== "ready") {
      parts.push("The open operation completed earlier. Current status is not ready.");
    }
  } else if (view.tool === "inspect_environment" && !view.activeUnreadable) {
    parts.push(environment.activeTaskId ? "The active operation could not be read." : "There is no active operation.");
  }
  if (view.activeOperation) parts.push(`Active operation ${view.activeOperation.taskId} is ${view.activeOperation.status}.`);
  if (view.activeUnreadable) parts.push("The active operation could not be read.");
  if (assessment.disposition === "waiting_for_input") {
    parts.push("Waiting for input is not success. This version cannot submit an answer.");
    for (const question of facts.questions) parts.push(`Question ${question.id}: ${question.message}`);
  }
  if (environment.status === "closing") parts.push("closing is not closed.");
  if (environment.status === "closed") parts.push("closed confirms capacity release.");
  if (!assessment.workFinished) parts.push("This is not finished. Inspect once when asked. Do not poll.");
  if (assessment.disposition === "result" && facts.resultText && !commandOutcome(facts.outcome)) {
    parts.push("A final response does not certify that the requested objective succeeded.");
  }
  if (view.dispatch === "unknown") parts.push("Reuse the same idempotency key. Do not open another Environment.");
  if (view.dispatch === "rejected") parts.push("Dispatch was rejected. Do not treat the Environment as ready.");
  return parts.join(" ");
}

function commandOutcome(outcome: unknown): boolean {
  return typeof outcome === "object" && outcome !== null && "exitCode" in outcome;
}

function lifecycleKind(view: OrdinaryView): "open" | "close" | undefined {
  if (view.tool === "open_environment") return "open";
  if (view.tool === "close_environment") return "close";
  const id = view.operation?.taskId;
  if (id?.endsWith("_open")) return "open";
  if (id?.endsWith("_close")) return "close";
  return undefined;
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
