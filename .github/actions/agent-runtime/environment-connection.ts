import WebSocket from "ws";
import { z } from "zod";

const connectedSchema = z.object({ type: z.literal("connected"),
  generation: z.number().int().positive(), deadline: z.number().int().positive(),
}).strict();

export type RuntimeConnection = {
  socket: WebSocket;
  generation: number;
  deadline: number;
  // Transport closure is not evidence that the Environment stopped.
  closed: Promise<{ code: number }>;
};

/** One authenticated connection attempt; retries belong to the runtime owner. */
export async function connectEnvironment(url: URL, runtimeId: string,
  getToken: () => Promise<string>, signal: AbortSignal): Promise<RuntimeConnection> {
  if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.hash || url.search || !z.string().uuid().safeParse(runtimeId).success) {
    throw new Error("INVALID_ENVIRONMENT_CONNECTION");
  }
  signal.throwIfAborted();
  const token = await getToken();
  signal.throwIfAborted();
  if (!token) throw new Error("RUNNER_IDENTITY_UNAVAILABLE");
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, "x-harness-runtime-id": runtimeId },
    followRedirects: false, perMessageDeflate: false, maxPayload: 128 * 1024,
  });
  const closed = new Promise<{ code: number }>(resolve => socket.once("close", code => resolve({ code })));
  return new Promise<RuntimeConnection>((resolve, reject) => {
    const fail = () => {
      signal.removeEventListener("abort", abort);
      socket.terminate();
      reject(new Error("ENVIRONMENT_CONNECTION_FAILED"));
    };
    const abort = () => fail();
    // Keep an error listener for the socket's lifetime: later failures are
    // represented by closed, not an uncaught EventEmitter error or raw logs.
    socket.on("error", fail);
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("ENVIRONMENT_CONNECTION_CLOSED"));
    });
    socket.once("message", (bytes, binary) => {
      if (binary) return fail();
      let value: unknown;
      try { value = JSON.parse(bytes.toString()); } catch { return fail(); }
      const parsed = connectedSchema.safeParse(value);
      if (!parsed.success || parsed.data.deadline <= Date.now()) return fail();
      signal.removeEventListener("abort", abort);
      resolve({ socket, closed, generation: parsed.data.generation, deadline: parsed.data.deadline });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
