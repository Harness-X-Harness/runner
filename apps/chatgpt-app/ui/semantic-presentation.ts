import type { Snapshot } from "./view.ts";

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

/** RED-phase seam: issue #207 implements the projector. Fallback stays unchanged. */
export function selectSemanticPresentation(_snapshot: Snapshot): CommandPresentation | null {
  return null;
}
