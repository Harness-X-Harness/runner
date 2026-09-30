/** Observations only. No category supplies Environment stop or release authority. */
export type ReconnectFailureCategory = "runner_identity" | "handshake" | "handshake_rejected"
  | "control_plane_rejected" | "transport_closed" | "transport_failure" | "unknown";
export type ReconnectDiagnostic = { category: ReconnectFailureCategory; observedAt: number };
