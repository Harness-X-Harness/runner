import { DurableObject } from "cloudflare:workers";

import {
  expireSessions,
  handleSessionRequest,
  pendingGenerationCommands,
  terminateGenerationSessions,
} from "./session-state.js";
import {
  ENVIRONMENT_CHANNEL_PROTOCOL,
  channelAllowsSessionAction,
  connectEnvironmentChannel as connectChannelState,
  disconnectEnvironmentChannel,
  parseEnvironmentChannelMessage,
} from "./environment-channel.js";

const STORAGE_KEY = "environment";
const ACTIVE_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);

export class EnvironmentObject extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/sessions" || path.startsWith("/sessions/")) {
      const action = request.method === "POST"
        ? await request.clone().json().catch(() => undefined)
        : undefined;
      const environment = /** @type {any} */ (await this.ctx.storage.get(STORAGE_KEY));
      if (!channelAllowsSessionAction(environment, action)) {
        return Response.json({ error: "Environment channel is disconnected" }, { status: 409 });
      }
      const response = await handleSessionRequest(this.ctx.storage, request);
      if (request.method === "POST" && response.ok && action?.generation) {
        await this.sendPendingCommands(String(action.generation));
      }
      return response;
    }

    if (request.method === "GET" && path === "/environment") {
      const environment = await this.ctx.storage.get(STORAGE_KEY);
      return environment
        ? Response.json(environment)
        : Response.json({ error: "environment not found" }, { status: 404 });
    }

    if (request.method === "POST" && path === "/environment/open") {
      const requestBody = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (current && ACTIVE_STATUSES.has(current.status)) {
          return { environment: current, dispatch: false };
        }
        const environment = {
          ownerId: String(requestBody.ownerId),
          generation: String(requestBody.generation),
          slot: current?.slot ?? crypto.randomUUID(),
          status: "dispatching",
          dispatchOutcome: "unconfirmed",
          cancelPending: false,
          createdAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return { environment, dispatch: true };
      });
      return Response.json(result, { status: result.dispatch ? 201 : 200 });
    }

    if (
      request.method === "POST" &&
      (path === "/environment/dispatch" || path === "/environment/claim")
    ) {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (!current || current.generation !== String(event.generation)) {
          return undefined;
        }
        if (
          (current.status === "closing" ||
            (path === "/environment/dispatch" &&
              current.status === "offline" && current.closeRequested)) &&
          !current.runId
        ) {
          const environment = {
            ...current,
            status: "closing",
            runId: String(event.runId),
            runUrl: String(event.runUrl),
            runAttempt: path === "/environment/claim" ? String(event.runAttempt) : undefined,
            cancelPending: true,
            updatedAt: new Date().toISOString(),
          };
          await storage.put(STORAGE_KEY, environment);
          return { environment, cancel: true };
        }
        if (
          ["starting", "ready", "closing"].includes(current.status) &&
          current.runId === String(event.runId)
        ) {
          if (path === "/environment/claim") {
            const runAttempt = String(event.runAttempt);
            if (current.runAttempt !== undefined && current.runAttempt !== runAttempt) {
              return undefined;
            }
            if (current.runAttempt === undefined) {
              const environment = { ...current, runAttempt };
              await storage.put(STORAGE_KEY, environment);
              return {
                environment,
                cancel: current.status === "closing" && current.cancelPending !== false,
              };
            }
          }
          return {
            environment: current,
            cancel: current.status === "closing" && current.cancelPending !== false,
          };
        }
        if (current.status !== "dispatching") {
          return undefined;
        }
        const environment = {
          ...current,
          status: "starting",
          runId: String(event.runId),
          runUrl: String(event.runUrl),
          runAttempt: path === "/environment/claim" ? String(event.runAttempt) : undefined,
          dispatchOutcome: undefined,
          cancelPending: false,
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return { environment, cancel: false };
      });
      return result
        ? Response.json(result)
        : Response.json(
          { error: "environment generation mismatch" },
          { status: 409 },
        );
    }

    if (request.method === "POST" && path === "/environment/dispatch-unknown") {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (!current || current.generation !== String(event.generation)) {
          return undefined;
        }
        if (current.status !== "dispatching") return current;
        const environment = {
          ...current,
          dispatchOutcome: "unknown",
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return environment;
      });
      return result
        ? Response.json(result)
        : Response.json({ error: "environment generation mismatch" }, { status: 409 });
    }

    if (request.method === "POST" && path === "/environment/dispatch-failed") {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (!current || current.generation !== String(event.generation)) {
          return undefined;
        }
        if (current.status !== "dispatching" || current.runId) return current;
        const environment = {
          ownerId: current.ownerId,
          generation: current.generation,
          slot: current.slot,
          status: "offline",
          cancelPending: false,
          closeRequested: false,
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        await terminateGenerationSessions(
          storage,
          current.generation,
          "startup_failed",
        );
        return environment;
      });
      return result
        ? Response.json(result)
        : Response.json({ error: "environment generation mismatch" }, { status: 409 });
    }

    if (request.method === "POST" && path === "/environment/channel/prepare") {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (
          !current ||
          current.generation !== String(event.generation) ||
          current.runId !== String(event.runId) ||
          current.runAttempt !== String(event.runAttempt) ||
          !["starting", "ready"].includes(current.status)
        ) return undefined;
        const environment = {
          ...current,
          channelPreparation: {
            pairingUrl: String(event.pairingUrl),
            t3Url: String(event.t3Url),
            tailscaleHost: String(event.tailscaleHost),
          },
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return environment;
      });
      return result
        ? Response.json(result)
        : Response.json({ error: "environment channel preparation is stale" }, { status: 409 });
    }

    if (request.method === "GET" && path === "/environment/channel") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
      }
      const attachment = {
        generation: request.headers.get("x-environment-generation") ?? "",
        runId: request.headers.get("x-environment-run-id") ?? "",
        runAttempt: request.headers.get("x-environment-run-attempt") ?? "",
        connectionId: crypto.randomUUID(),
      };
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment(attachment);
      this.ctx.acceptWebSocket(server, ["environment-channel"]);
      const environment = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        const next = connectChannelState(current, {
          ...attachment,
          descriptor: current?.channelPreparation,
        });
        if (!next) return undefined;
        next.channelPreparation = undefined;
        await storage.put(STORAGE_KEY, next);
        return next;
      });
      if (!environment) {
        server.close(1008, "stale Environment channel");
        return Response.json({ error: "environment channel is stale" }, { status: 409 });
      }
      for (const socket of this.ctx.getWebSockets("environment-channel")) {
        if (socket !== server) socket.close(1000, "Environment channel replaced");
      }
      await this.sendPendingCommands(environment.generation, server);
      return new Response(null, {
        status: 101,
        headers: { "sec-websocket-protocol": ENVIRONMENT_CHANNEL_PROTOCOL },
        webSocket: client,
      });
    }

    if (request.method === "POST" && path === "/environment/close") {
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (!current || !ACTIVE_STATUSES.has(current.status)) return undefined;
        if (current.status === "dispatching" && !current.runId) {
          const environment = {
            ownerId: current.ownerId,
            generation: current.generation,
            slot: current.slot,
            status: "offline",
            cancelPending: false,
            closeRequested: true,
            updatedAt: new Date().toISOString(),
          };
          await storage.put(STORAGE_KEY, environment);
          await terminateGenerationSessions(
            storage,
            current.generation,
            "stopped",
          );
          return { environment, cancel: false };
        }
        if (current.status === "closing") {
          const cancelPending = Boolean(
            current.runId && current.cancelPending !== false,
          );
          const environment = current.cancelPending === undefined
            ? { ...current, cancelPending }
            : current;
          if (environment !== current) await storage.put(STORAGE_KEY, environment);
          return { environment, cancel: cancelPending };
        }
        const environment = {
          ...current,
          status: "closing",
          cancelPending: Boolean(current.runId),
          pairingUrl: undefined,
          t3Url: undefined,
          tailscaleHost: undefined,
          channelState: "disconnected",
          connectionId: undefined,
          channelPreparation: undefined,
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return { environment, cancel: true };
      });
      if (result?.environment?.status === "closing" || result?.environment?.status === "offline") {
        this.closeChannels();
      }
      return result
        ? Response.json(result)
        : Response.json({ error: "environment not found" }, { status: 404 });
    }

    if (request.method === "POST" && path === "/environment/cancel") {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (
          !current ||
          current.status !== "closing" ||
          current.runId !== String(event.runId)
        ) return undefined;
        if (current.cancelPending === false) return current;
        const environment = {
          ...current,
          cancelPending: false,
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return environment;
      });
      return result
        ? Response.json(result)
        : Response.json({ error: "environment run mismatch" }, { status: 409 });
    }

    if (request.method === "POST" && path === "/environment/terminal") {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (!current || current.runId !== String(event.runId)) return undefined;
        const environment = {
          ownerId: current.ownerId,
          generation: current.generation,
          slot: current.slot,
          runId: current.runId,
          runUrl: current.runUrl,
          status: "offline",
          cancelPending: false,
          closeRequested: current.closeRequested,
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        await terminateGenerationSessions(
          storage,
          current.generation,
          current.closeRequested ? "stopped" : "environment_ended",
        );
        return environment;
      });
      if (result) this.closeChannels();
      return result
        ? Response.json(result)
        : Response.json({ error: "environment run mismatch" }, { status: 409 });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  async alarm() {
    await expireSessions(this.ctx.storage);
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    const current = /** @type {any} */ (await this.ctx.storage.get(STORAGE_KEY));
    if (
      current?.status !== "ready" ||
      current.connectionId !== attachment?.connectionId ||
      current.generation !== attachment?.generation
    ) {
      socket.close(1008, "stale Environment channel");
      return;
    }
    const incoming = parseEnvironmentChannelMessage(message, attachment);
    if (!incoming) {
      socket.close(1008, "invalid Environment channel message");
      return;
    }
    const action = incoming.type === "ack"
      ? { type: "process_command", generation: incoming.generation, commandId: incoming.commandId }
      : incoming.type === "event"
        ? { type: "append_event", generation: incoming.generation, event: incoming.event }
        : { ...incoming.action, generation: incoming.generation };
    const response = await handleSessionRequest(
      this.ctx.storage,
      new Request(`https://environment/sessions/${incoming.sessionId}`, {
        method: "POST",
        body: JSON.stringify(action),
      }),
    );
    if (!response.ok) socket.close(1008, "rejected Environment channel message");
  }

  async webSocketClose(socket) {
    await this.disconnectChannel(socket.deserializeAttachment());
  }

  async webSocketError(socket) {
    await this.disconnectChannel(socket.deserializeAttachment());
  }

  async disconnectChannel(attachment) {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get(STORAGE_KEY);
      const next = disconnectEnvironmentChannel(current, attachment);
      if (next !== current) await storage.put(STORAGE_KEY, next);
    });
  }

  async sendPendingCommands(generation, onlySocket) {
    const commands = await pendingGenerationCommands(this.ctx.storage, generation);
    if (commands.length === 0) return;
    const message = JSON.stringify({ type: "commands", generation, commands });
    const sockets = onlySocket ? [onlySocket] : this.ctx.getWebSockets("environment-channel");
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.generation !== generation) continue;
      try {
        socket.send(message);
      } catch {
        // The close/error handler owns durable disconnect state.
      }
    }
  }

  closeChannels() {
    for (const socket of this.ctx.getWebSockets("environment-channel")) {
      socket.close(1000, "Environment ended");
    }
  }
}
