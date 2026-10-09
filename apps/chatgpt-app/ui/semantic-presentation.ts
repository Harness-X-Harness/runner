import { commandOutcome, snapshotSchema, type Snapshot } from "./view.ts";
import { z } from "zod";

/** Presentation is trusted only when sourced from the authenticated AgentEnv operation tool.
 * Model prose, stdout/stderr and parsed JSON strings cannot confer execution authority.
 */
export type CommandPresentation = {
  kind: "command-result";
  status: "passed" | "failed" | "cancelled" | "timed-out";
  evidence: {
    source: "runner-command";
    operationId: string;
    exitCode: number | null;
    signal: string | null;
    stopReason: "cancelled" | "timeout" | null;
    truncated: boolean;
    historical: boolean;
  };
};

// Restrict generated evidence to machine fields; arbitrary strings cannot become evidence.
const evidenceOutcome = commandOutcome.extend({
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.enum(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT",
    "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM",
    "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU",
    "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPOLL",
    "SIGPWR", "SIGSYS", "SIGUNUSED"]).nullable().optional(),
}).strict();

/** Caller supplies only owner-authorized MCP structuredContent delivered through the host
 * tool-result bridge (see main.tsx). Shape validation is defensive, not authentication.
 * Never call this on model text, parsed text/JSON, logs or output resources.
 */
export function selectSemanticPresentation(snapshot: Snapshot): CommandPresentation | null {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (!/^env_[a-f0-9]{32}$/.test(s.environmentId) ||
      !/^task_[a-f0-9]{32}_[a-f0-9]{32}$/.test(s.operationId ?? "") ||
      !s.operationId?.startsWith(`task_${s.environmentId.slice(4)}_`) ||
      !["completed", "cancelled"].includes(s.operationStatus ?? "")) return null;
  const historical = s.historical === true;
  if (s.activeOperationId === s.operationId ||
      (s.activeOperationId && (!historical ||
        !/^task_[a-f0-9]{32}_(?:[a-f0-9]{32}|open|close)$/.test(s.activeOperationId) ||
        !s.activeOperationId.startsWith(`task_${s.environmentId.slice(4)}_`)))) return null;
  // workFinished describes the whole workspace, including unrelated active work.
  const activeHistory = historical && Boolean(s.activeOperationId);
  if (!s.workFinished && !activeHistory) return null;
  if (s.disposition !== "result" && !(s.operationStatus === "cancelled" && s.disposition === "cancelled") &&
      !(activeHistory && s.disposition === "waiting_for_input")) return null;
  const outcome = evidenceOutcome.safeParse(s.outcome);
  if (!outcome.success) return null;
  const c = outcome.data;
  if (s.operationStatus === "cancelled" && c.stopReason !== "cancelled") return null;
  if (c.exitCode === null && c.signal == null && c.stopReason === undefined) return null;
  const status = c.stopReason === "cancelled" ? "cancelled" : c.stopReason === "timeout" ? "timed-out"
    : c.exitCode === 0 && c.signal == null ? "passed" : "failed";
  return { kind: "command-result", status, evidence: {
    source: "runner-command", operationId: s.operationId,
    exitCode: c.exitCode, signal: c.signal ?? null, stopReason: c.stopReason ?? null,
    truncated: c.truncated, historical,
  } };
}
