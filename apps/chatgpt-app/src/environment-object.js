import { DurableObject } from "cloudflare:workers";

import {
  createSessionRecord,
  environmentTerminalReason,
  expireSessions,
  handleSessionRequest,
  pendingGenerationCommands,
  startGenerationQueuedTurns,
  terminateGenerationSessions,
} from "./session-state.js";
import {
  ENVIRONMENT_CHANNEL_PROTOCOL,
  channelAllowsSessionAction,
  channelResponseIsFatal,
  connectEnvironmentChannel as connectChannelState,
  disconnectEnvironmentChannel,
  parseEnvironmentChannelMessage,
} from "./environment-channel.js";
import { publicSessionSnapshot } from "./session-public.js";

const STORAGE_KEY = "environment";
const ACTIVE_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);
const encoder = new TextEncoder();

class SessionCreationError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class EnvironmentObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sessionSubscribers = new Set();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    const streamMatch = path.match(/^\/sessions\/([^/]+)\/stream$/);
    if (request.method === "GET" && streamMatch) {
      return this.openSessionStream(
        decodeURIComponent(streamMatch[1]),
        request.headers.get("x-session-grant-id") ?? "",
        Number(new URL(request.url).searchParams.get("after") ?? 0),
      );
    }

    if (path === "/sessions" || path.startsWith("/sessions/")) {
      const action = request.method === "POST"
        ? await request.clone().json().catch(() => undefined)
        : undefined;
      const environment = /** @type {any} */ (await this.ctx.storage.get(STORAGE_KEY));
      if (request.method === "POST" && path === "/sessions" &&
          (!environment || !ACTIVE_STATUSES.has(environment.status) ||
            String(action?.generation) !== environment.generation)) {
        return Response.json({ error: "Environment generation is not active" }, { status: 409 });
      }
      if (!channelAllowsSessionAction(environment, action)) {
        return Response.json({ error: "Environment channel is disconnected" }, { status: 409 });
      }
      let response = await handleSessionRequest(this.ctx.storage, request);
      const committedResourceTerminal = response.status === 429;
      if (request.method === "POST" &&
          (response.ok || committedResourceTerminal) && action?.generation) {
        if (response.ok && action.type === "queue_turn" &&
            environment?.channelState === "connected") {
          const started = await startGenerationQueuedTurns(
            this.ctx.storage,
            String(action.generation),
          );
          if (started > 0) {
            response = await handleSessionRequest(
              this.ctx.storage,
              new Request(request.url, { method: "GET" }),
            );
          }
        }
        if (response.ok) await this.sendPendingCommands(String(action.generation));
        await this.broadcastSession(path.split("/")[2]);
      }
      return response;
    }

    if (request.method === "POST" && path === "/environment/start-session") {
      const requestBody = await request.json();
      if (
        typeof requestBody.ownerId !== "string" || requestBody.ownerId.length === 0 ||
        typeof requestBody.newGeneration !== "string" || requestBody.newGeneration.length === 0 ||
        !requestBody.session || typeof requestBody.session !== "object"
      ) return Response.json({ error: "invalid Session start" }, { status: 400 });
      let result;
      try {
        result = await this.ctx.storage.transaction(async (storage) => {
          const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
          const now = new Date();
          let environment;
          let dispatch = false;
          if (current && ACTIVE_STATUSES.has(current.status) && current.status !== "closing") {
            environment = current;
          } else if (current?.status === "closing") {
            const replacementGeneration = current.replacementGeneration ??
              String(requestBody.newGeneration);
            environment = current.replacementGeneration
              ? current
              : {
                  ...current,
                  replacementGeneration,
                  updatedAt: now.toISOString(),
                };
            if (environment !== current) await storage.put(STORAGE_KEY, environment);
          } else {
            const generation = current?.replacementGeneration ?? String(requestBody.newGeneration);
            environment = {
              ownerId: String(requestBody.ownerId),
              generation,
              slot: current?.slot ?? crypto.randomUUID(),
              status: "dispatching",
              dispatchOutcome: "unconfirmed",
              cancelPending: false,
              closeRequested: false,
              createdAt: now.toISOString(),
            };
            await storage.put(STORAGE_KEY, environment);
            dispatch = true;
          }
          const generation = environment.status === "closing"
            ? environment.replacementGeneration
            : environment.generation;
          const created = await createSessionRecord(
            storage,
            { ...requestBody.session, generation },
            now,
          );
          if (created.status !== 201) {
            throw new SessionCreationError(created.body.error, created.status);
          }
          return { environment, dispatch, ...created.body };
        });
      } catch (error) {
        if (error instanceof SessionCreationError) {
          return Response.json({ error: error.message }, { status: error.status });
        }
        throw error;
      }
      const generation = result.environment.status === "closing"
        ? result.environment.replacementGeneration
        : result.environment.generation;
      if (result.environment.channelState === "connected") {
        await this.sendPendingCommands(generation);
      }
      return Response.json(result, { status: 201 });
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
          generation: current?.replacementGeneration ?? String(requestBody.generation),
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
      await startGenerationQueuedTurns(this.ctx.storage, environment.generation);
      await this.sendPendingCommands(environment.generation, server);
      await this.broadcastAllSessions();
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
        await this.broadcastAllSessions();
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
        const terminalReason = environmentTerminalReason(current);
        const environment = {
          ownerId: current.ownerId,
          generation: current.generation,
          slot: current.slot,
          runId: current.runId,
          runUrl: current.runUrl,
          status: "offline",
          cancelPending: false,
          closeRequested: current.closeRequested,
          replacementGeneration: current.replacementGeneration,
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        await terminateGenerationSessions(
          storage,
          current.generation,
          terminalReason,
        );
        return environment;
      });
      if (result) this.closeChannels();
      if (result) await this.broadcastAllSessions();
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
    if (channelResponseIsFatal(response)) {
      socket.close(1008, "rejected Environment channel message");
    } else {
      if (incoming.type === "transition" && incoming.action.type === "complete_turn") {
        await this.sendPendingCommands(incoming.generation, socket);
      }
      await this.broadcastSession(incoming.sessionId);
    }
  }

  async webSocketClose(socket) {
    await this.disconnectChannel(socket.deserializeAttachment());
  }

  async webSocketError(socket) {
    await this.disconnectChannel(socket.deserializeAttachment());
  }

  async disconnectChannel(attachment) {
    let changed = false;
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get(STORAGE_KEY);
      const next = disconnectEnvironmentChannel(current, attachment);
      if (next !== current) {
        await storage.put(STORAGE_KEY, next);
        changed = true;
      }
    });
    if (changed) await this.broadcastAllSessions();
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

  async openSessionStream(sessionId, grantId, after) {
    if (!validStreamId(sessionId) || !validStreamId(grantId)) {
      return Response.json({ error: "Session stream authorization required" }, { status: 401 });
    }
    const read = await this.readSessionStreamPage(sessionId, grantId, after);
    if (!read) return Response.json({ error: "Session not found" }, { status: 404 });
    let subscriber;
    const body = new ReadableStream({
      start: (controller) => {
        controller.enqueue(streamLine({ type: "snapshot", ...read }));
        if (read.session.phase === "terminal" || read.hasMore) {
          controller.close();
          return;
        }
        subscriber = {
          sessionId,
          grantId,
          cursor: read.nextCursor,
          controller,
        };
        this.sessionSubscribers.add(subscriber);
      },
      cancel: () => {
        if (subscriber) this.sessionSubscribers.delete(subscriber);
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    });
  }

  async broadcastSession(sessionId) {
    if (!sessionId) return;
    for (const subscriber of [...this.sessionSubscribers]) {
      if (subscriber.sessionId !== sessionId) continue;
      try {
        const read = await this.readSessionStreamPage(
          sessionId,
          subscriber.grantId,
          subscriber.cursor,
        );
        if (!read) throw new Error("Session not found");
        subscriber.controller.enqueue(streamLine({ type: "update", ...read }));
        subscriber.cursor = read.nextCursor;
        if (read.session.phase === "terminal" || read.hasMore) {
          subscriber.controller.close();
          this.sessionSubscribers.delete(subscriber);
        }
      } catch (error) {
        try {
          subscriber.controller.error(error);
        } catch {
          // The browser already closed the stream.
        }
        this.sessionSubscribers.delete(subscriber);
      }
    }
  }

  async broadcastAllSessions() {
    const sessionIds = new Set([...this.sessionSubscribers].map(({ sessionId }) => sessionId));
    for (const sessionId of sessionIds) await this.broadcastSession(sessionId);
  }

  async readSessionStreamPage(sessionId, grantId, after) {
    const response = await handleSessionRequest(
      this.ctx.storage,
      new Request(
        `https://environment/sessions/${encodeURIComponent(sessionId)}?after=${safeCursor(after)}&limit=100`,
      ),
    );
    if (!response.ok) return undefined;
    const read = await response.json();
    const environment = /** @type {any} */ (await this.ctx.storage.get(STORAGE_KEY));
    return {
      session: publicSessionSnapshot(
        read.session,
        environment,
        grantId,
        this.env.TASK_CONTROL_PLANE_URL,
      ),
      events: read.events,
      nextCursor: read.nextCursor,
      hasMore: read.hasMore,
    };
  }
}

function streamLine(value) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function safeCursor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validStreamId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
