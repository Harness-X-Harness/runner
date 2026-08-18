import { DurableObject } from "cloudflare:workers";

import {
  expireSessions,
  handleSessionRequest,
  terminateGenerationSessions,
} from "./session-state.js";

const STORAGE_KEY = "environment";
const ACTIVE_STATUSES = new Set(["dispatching", "starting", "ready", "closing"]);

export class EnvironmentObject extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === "/sessions" || path.startsWith("/sessions/")) {
      return handleSessionRequest(this.ctx.storage, request);
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

    if (request.method === "POST" && path === "/environment/ready") {
      const event = await request.json();
      const result = await this.ctx.storage.transaction(async (storage) => {
        const current = /** @type {any} */ (await storage.get(STORAGE_KEY));
        if (
          !current ||
          current.generation !== String(event.generation) ||
          current.runId !== String(event.runId) ||
          current.status !== "starting"
        ) return undefined;
        const environment = {
          ...current,
          status: "ready",
          pairingUrl: String(event.pairingUrl),
          t3Url: String(event.t3Url),
          tailscaleHost: String(event.tailscaleHost),
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return environment;
      });
      return result
        ? Response.json(result)
        : Response.json({ error: "environment callback is stale" }, { status: 409 });
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
          updatedAt: new Date().toISOString(),
        };
        await storage.put(STORAGE_KEY, environment);
        return { environment, cancel: true };
      });
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
      return result
        ? Response.json(result)
        : Response.json({ error: "environment run mismatch" }, { status: 409 });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  async alarm() {
    await expireSessions(this.ctx.storage);
  }
}
