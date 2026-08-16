import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "state";

/** @typedef {{value: Record<string, unknown>, expiresAt: number}} StoredState */

export class AuthorizationStateObject extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (request.method === "PUT" && path === "/state") {
      const { value, ttlSeconds } = /** @type {{value: Record<string, unknown>, ttlSeconds: number}} */ (
        await request.json()
      );
      const expiresAt = Date.now() + ttlSeconds * 1000;
      await this.ctx.storage.put(STORAGE_KEY, { value, expiresAt });
      await this.ctx.storage.setAlarm(expiresAt);
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && path === "/state") {
      const state = await this.currentState();
      return state ? Response.json(state.value) : new Response(null, { status: 404 });
    }

    if (request.method === "POST" && path === "/state/consume") {
      const { browserBindingHash } = await request.json();
      const result = await this.ctx.storage.transaction(async (transaction) => {
        const state = /** @type {StoredState | undefined} */ (
          await transaction.get(STORAGE_KEY)
        );
        if (!state || state.expiresAt <= Date.now()) {
          if (state) await transaction.delete(STORAGE_KEY);
          return { kind: "missing" };
        }
        if (state.value.browserBindingHash !== browserBindingHash) {
          return { kind: "browser_mismatch" };
        }
        await transaction.delete(STORAGE_KEY);
        return { kind: "consumed", value: state.value };
      });
      if (result.kind === "missing") return new Response(null, { status: 404 });
      if (result.kind === "browser_mismatch") {
        return new Response(null, { status: 403 });
      }
      await this.ctx.storage.deleteAlarm();
      return Response.json(result.value);
    }

    if (request.method === "DELETE" && path === "/state") {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 404 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  async currentState() {
    const state = /** @type {StoredState | undefined} */ (
      await this.ctx.storage.get(STORAGE_KEY)
    );
    if (!state || state.expiresAt > Date.now()) return state;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return undefined;
  }
}
