import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "state";

type StoredState = { value: Record<string, unknown>; expiresAt: number };

export class AuthorizationStateObject extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (request.method === "PUT" && path === "/state") {
      const { value, ttlSeconds } = await request.json<{ value: Record<string, unknown>; ttlSeconds: number }>();
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
      const { browserBindingHash } = await request.json<{ browserBindingHash: string }>();
      const result = await this.ctx.storage.transaction(async (transaction) => {
        const state = await transaction.get<StoredState>(STORAGE_KEY);
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
    const state = await this.ctx.storage.get<StoredState>(STORAGE_KEY);
    if (!state || state.expiresAt > Date.now()) return state;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return undefined;
  }
}
