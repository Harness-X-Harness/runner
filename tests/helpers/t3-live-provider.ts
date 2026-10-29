import { createRequire } from "node:module";
import { jsonObject, privateT3Json, privateT3Command, type T3CliOptions } from "./t3-live.ts";

const require = createRequire(new URL("../../.github/actions/agent-runtime/package.json", import.meta.url));
type Socket = {
  on(event: "open" | "error" | "close", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  send(value: string): void; terminate(): void;
};
const WebSocket = require("ws") as new (url: string, options: { headers: Record<string, string> }) => Socket;

/** Only the fresh disposable acceptance HOME. Uses native T3 RPC, no DB/config patches or secret copies. */
export async function enableDisposableT3Provider(provider: "codex" | "grok", model: string,
  options: T3CliOptions): Promise<void> {
  const issued = await privateT3Json(["auth", "session", "issue", "--scope", "settings:write",
    "--scope", "providers:manage", "--ttl", "5m", "--json"], options);
  const session = jsonObject(issued.value);
  if (issued.exitCode !== 0 || typeof session.token !== "string" || typeof session.sessionId !== "string") {
    throw new Error("T3_LIVE_PROVIDER_SESSION_FAILED");
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:3773/ws?orchestrationProtocol=2", {
        headers: { Authorization: "Bearer " + session.token },
      });
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort); socket.terminate();
        if (success) resolve(); else reject(new Error("T3_LIVE_PROVIDER_SETTINGS_FAILED"));
      };
      const timer = setTimeout(() => finish(false), 40_000);
      const abort = () => finish(false);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { finish(false); return; }
      socket.on("error", () => finish(false));
      socket.on("close", () => finish(false));
      socket.on("open", () => { try { socket.send(JSON.stringify({
        _tag: "Request", id: "runner-provider-setup", tag: "server.updateSettings", headers: [],
        payload: { patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: provider,
          instance: { driver: provider, enabled: true, config: { customModels: [model] } } } },
      })); } catch { finish(false); } });
      socket.on("message", data => {
        try {
          const decoded: unknown = JSON.parse(String(data));
          for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
            const frame = jsonObject(item);
            if (frame._tag === "Exit" && frame.requestId === "runner-provider-setup") {
              finish(jsonObject(frame.exit)._tag === "Success");
            }
          }
        } catch { finish(false); }
      });
    });
  } catch { throw new Error("T3_LIVE_PROVIDER_SETTINGS_FAILED"); }
  finally {
    const revoked = await privateT3Command(["auth", "session", "revoke", session.sessionId], { ...options, signal: undefined });
    if (revoked.exitCode !== 0) throw new Error("T3_LIVE_PROVIDER_SESSION_REVOKE_FAILED");
  }
}
