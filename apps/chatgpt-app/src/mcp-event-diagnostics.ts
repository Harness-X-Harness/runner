const methods = new Set(["server/discover", "events/list", "events/subscribe", "events/unsubscribe"]);

/** Called after protocol parsing; never reread the stream or record parameters. */
export function observeMcpProtocolRejection(body: unknown, rpcCode: number,
  write: (record: Record<string, unknown>) => void = record => console.log(record)): void {
  const value = body !== null && typeof body === "object" && "method" in body ? body.method : undefined;
  const bodyMethod = typeof value !== "string" ? "absent"
    : methods.has(value) || value === "initialize" ? value : "other";
  write({ event: "mcp.protocol.rejected", bodyMethod, rpcCode });
}

/** Method-only observations; never log requests, headers, URLs or response data. */
export async function observeMcpEventRequest(request: Request, handle: () => Promise<Response>,
  write: (record: Record<string, unknown>) => void = record => console.log(record)): Promise<Response> {
  const header = request.headers.get("mcp-method");
  if (new URL(request.url).pathname !== "/mcp" || request.method !== "POST" || (header !== null && !methods.has(header))) return handle();
  const version = request.headers.get("mcp-protocol-version");
  const fields = { event: "mcp.events.wire", method: header ?? "unlabelled",
    protocol: version === "2026-07-28" ? version : version === null ? "absent" : "other" };
  write({ ...fields, phase: "received" });
  let response: Response;
  try { response = await handle(); }
  catch (error) { write({ ...fields, phase: "threw" }); throw error; }
  const result: Record<string, unknown> = {};
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const reply = await response.clone().json() as { error?: { code?: unknown }; result?: {
        capabilities?: { events?: unknown }; events?: unknown;
      } };
      if (Number.isSafeInteger(reply.error?.code)) result.rpcCode = reply.error!.code;
      if (reply.result && header === "server/discover") result.eventsAdvertised = reply.result.capabilities?.events !== undefined;
      if (Array.isArray(reply.result?.events) && header === "events/list") result.eventCount = reply.result.events.length;
    } catch { /* Diagnostics must not change a non-JSON or malformed response. */ }
  }
  write({ ...fields, phase: "returned", httpStatus: response.status, ...result });
  return response;
}
