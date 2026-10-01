import WebSocket from "ws";
import { z } from "zod";
import type { ReconnectFailureCategory } from "../../../shared/environment-reconnect.ts";

/** A local failure boundary, never an upstream exception or lifecycle decision. */
export class RuntimeConnectionError extends Error {
  readonly category: ReconnectFailureCategory;
  constructor(category: ReconnectFailureCategory) {
    super("ENVIRONMENT_CONNECTION_FAILED");
    this.category = category;
  }
}

const connectedSchema = z.object({ type: z.literal("connected"),
  generation: z.number().int().positive(), deadline: z.number().int().positive(),
}).strict();
const transportErrorCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);

export type RuntimeConnection = {
  socket: WebSocket;
  generation: number;
  deadline: number;
  // Transport closure is not evidence that the Environment stopped.
  closed: Promise<{ code: number; category?: ReconnectFailureCategory }>;
};

/** One authenticated connection attempt; retries belong to the runtime owner. */
export async function connectEnvironment(url: URL, runtimeId: string,
  getToken: () => Promise<string>, signal: AbortSignal): Promise<RuntimeConnection> {
  if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.hash || url.search || !z.string().uuid().safeParse(runtimeId).success) {
    throw new Error("INVALID_ENVIRONMENT_CONNECTION");
  }
  signal.throwIfAborted();
  let token: string;
  try { token = await getToken(); }
  catch { throw new RuntimeConnectionError("runner_identity"); }
  signal.throwIfAborted();
  if (!token) throw new RuntimeConnectionError("runner_identity");
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, "x-harness-runtime-id": runtimeId },
    followRedirects: false, perMessageDeflate: false, maxPayload: 128 * 1024,
  });
  let transportFailed = false;
  const closed = new Promise<{ code: number; category?: ReconnectFailureCategory }>(resolve =>
    socket.once("close", code => resolve({ code, ...(transportFailed ? { category: "transport_failure" as const } : {}) })));
  return new Promise<RuntimeConnection>((resolve, reject) => {
    let opened = false;
    const fail = (category: ReconnectFailureCategory) => {
      signal.removeEventListener("abort", abort);
      socket.terminate();
      reject(new RuntimeConnectionError(category));
    };
    const abort = () => fail("handshake");
    socket.once("open", () => { opened = true; });
    // Keep an error listener for the socket's lifetime: later failures are
    // represented by closed, not an uncaught EventEmitter error or raw logs.
    socket.on("error", error => {
      transportFailed = true;
      const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
      fail(opened || (code !== undefined && transportErrorCodes.has(code)) ? "transport_failure" : "handshake");
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      fail("handshake_rejected");
    });
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      reject(new RuntimeConnectionError("transport_closed"));
    });
    socket.once("message", (bytes, binary) => {
      if (binary) return fail("handshake");
      let value: unknown;
      try { value = JSON.parse(bytes.toString()); } catch { return fail("handshake"); }
      const parsed = connectedSchema.safeParse(value);
      if (!parsed.success || parsed.data.deadline <= Date.now()) return fail("handshake");
      signal.removeEventListener("abort", abort);
      // Close/error delivery can be lost. Probe only this authenticated socket;
      // retiring it reuses the existing reconnect owner, not a new Environment.
      let awaitingPong = false;
      const pong = () => { awaitingPong = false; };
      const probe = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (awaitingPong) { transportFailed = true; socket.terminate(); return; }
        awaitingPong = true;
        socket.ping();
      }, 30000);
      socket.on("pong", pong);
      socket.once("close", () => { clearInterval(probe); socket.off("pong", pong); });
      resolve({ socket, closed, generation: parsed.data.generation, deadline: parsed.data.deadline });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
