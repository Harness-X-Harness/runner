import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentEvents } from "../apps/chatgpt-app/src/environment-events.ts";
import { EVENT_NAME, eventRequestSchema, type SubscribeInput } from "../apps/chatgpt-app/src/mcp-events.ts";
import { Webhook } from "../apps/chatgpt-app/node_modules/standardwebhooks/dist/index.js";
import type { WebhookDelivery, WebhookDeliveryResult } from "../shared/webhook-delivery.ts";

class Storage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  private serial = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string | string[]) { for (const item of typeof key === "string" ? [key] : key) this.values.delete(item); }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const old = this.serial, release = Promise.withResolvers<void>(); this.serial = release.promise;
    await old;
    const backup = structuredClone(this.values), alarm = this.alarm;
    try { return await callback(); }
    catch (error) { this.values.clear(); for (const [key, value] of backup) this.values.set(key, value); this.alarm = alarm; throw error; }
    finally { release.resolve(); }
  }
}
const environmentId = `env_${"a".repeat(32)}`;
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const grant = { userId: "github-1", grantId: "grant", clientId: "client" };
const input: SubscribeInput = { name: EVENT_NAME, arguments: { environmentId },
  delivery: { mode: "webhook", url: "https://receiver.example/callback", secret }, cursor: null };
const initial = { kind: "environment", status: "opening" } as const;
const result = (status: number, body = ""): WebhookDeliveryResult => ({ kind: "response", status, body });
const confirm = (request: WebhookDelivery) => result(200, JSON.stringify({ challenge: JSON.parse(request.body).challenge }));
function fixture() {
  const storage = new Storage();
  const requests: WebhookDelivery[] = [];
  let clock = Date.now(), allowed = true;
  let deliver = async (request: WebhookDelivery) => {
    requests.push(request);
    return JSON.parse(request.body).type === "verification" ? confirm(request) : result(200);
  };
  let authorize = async () => allowed;
  const dependencies = { now: () => clock, deliver: (value: WebhookDelivery) => deliver(value), allowed: () => authorize() };
  const events = new EnvironmentEvents(storage as never, dependencies);
  return { events, storage, requests, dependencies, setTime(value: number) { clock = value; },
    advance(value: number) { clock += value; }, setAllowed(value: boolean) { allowed = value; },
    setDeliver(value: typeof deliver) { deliver = value; }, setAuthorize(value: typeof authorize) { authorize = value; } };
}

test("webhook subscribe verifies, persists, refreshes one identity and sends secret-free signed state", async () => {
  const f = fixture();
  const subscribed = await f.events.subscribe("1", grant, input, initial);
  assert.equal(f.requests.length, 1);
  const challenge = new Webhook(secret).verify(f.requests[0].body, f.requests[0].headers) as { type: string };
  assert.equal(challenge.type, "verification");
  assert.equal(subscribed.cursor, null);
  const refreshed = await f.events.subscribe("1", grant, { ...input, ttlMs: 120000 }, initial);
  assert.equal(refreshed.id, subscribed.id);
  assert.equal(f.requests.length, 1); // bounded callback verification cache
  assert.equal((await f.storage.list({ prefix: "environment-event-sub:" })).size, 1);
  const reloaded = new EnvironmentEvents(f.storage as never, f.dependencies);
  await reloaded.flush();
  const delivery = f.requests[1];
  const event = new Webhook(secret).verify(delivery.body, delivery.headers) as { eventId: string; data: unknown };
  assert.equal(delivery.headers["webhook-id"], event.eventId);
  assert.deepEqual(event.data, { ...initial, environmentId, revision: 1 });
  assert.doesNotMatch(delivery.body, /whsec_|github-1|grant|client|callback/);
  const alarmBefore = f.storage.alarm;
  await f.storage.transaction(async () => {
    await reloaded.publish(environmentId, { kind: "environment", status: "ready" });
    throw new Error("source commit rejected");
  }).catch(() => {});
  assert.equal((await f.storage.list({ prefix: "environment-event-queue:" })).size, 0);
  assert.equal(f.storage.alarm, alarmBefore);
  await f.events.unsubscribe("1", input);
  await f.events.unsubscribe("1", input);
  assert.equal(await f.events.nextAlarm(), undefined);
});

test("unsubscribe and replacement reject delayed verification, never resurrect a subscription", async () => {
  for (const mode of ["unsubscribe", "replacement", "expiry", "revoked"] as const) {
    const f = fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.setDeliver(async request => { started.resolve(); await release.promise; return confirm(request); });
    const pending = f.events.subscribe("1", grant, input, initial);
    const rejected = assert.rejects(pending, /Subscription/);
    await started.promise;
    if (mode === "unsubscribe") await f.events.unsubscribe("1", input);
    if (mode === "expiry") f.advance(2 * 3600000);
    if (mode === "revoked") f.setAllowed(false);
    if (mode === "replacement") {
      f.setDeliver(async request => confirm(request));
      await f.events.subscribe("1", grant, { ...input, delivery: { ...input.delivery, secret: `whsec_${Buffer.alloc(32, 9).toString("base64")}` } }, initial);
    }
    release.resolve(); await rejected;
    const subscriptions = [...(await f.storage.list<{ active: boolean; secret: string }>({ prefix: "environment-event-sub:" })).values()];
    assert.equal(subscriptions.length, mode === "replacement" ? 1 : 0);
    if (mode === "replacement") assert.notEqual(subscriptions[0].secret, secret);
  }
});

test("activation and refresh capture state committed during callback verification", async () => {
  const f = fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.setDeliver(async request => { started.resolve(); await release.promise; return confirm(request); });
  const pending = f.events.subscribe("1", grant, input, initial);
  await started.promise;
  await f.storage.transaction(() => f.events.publish(environmentId, { kind: "environment", status: "ready" }));
  release.resolve(); await pending;
  const queue = [...(await f.storage.list<{ event: { data: { status: string } } }>({ prefix: "environment-event-queue:" })).values()];
  assert.deepEqual(queue.map(value => value.event.data.status), ["ready"]);
  await f.events.flush();
  f.advance(11 * 60000); // callback verification cache expired
  const started2 = Promise.withResolvers<void>(), release2 = Promise.withResolvers<void>();
  f.setDeliver(async request => { started2.resolve(); await release2.promise; return confirm(request); });
  const refresh = f.events.subscribe("1", grant, input, initial);
  await started2.promise;
  await f.storage.transaction(() => f.events.publish(environmentId, { kind: "environment", status: "closed" }));
  release2.resolve(); await refresh;
  assert.deepEqual([...(await f.storage.list<{ event: { data: { status: string } } }>({ prefix: "environment-event-queue:" })).values()].map(value => value.event.data.status), ["closed"]);
});

test("delivery retries retain event identity, rotate signatures and stop at finite limits", async () => {
  const f = fixture();
  await f.events.subscribe("1", grant, { ...input, ttlMs: 24 * 3600000 }, initial);
  f.setDeliver(async request => { f.requests.push(request); return result(503); });
  for (let index = 0; index < 5; index++) { await f.events.flush(); f.advance(20 * 60000); }
  assert.equal(f.requests.length, 6); // one verification + five delivery attempts
  assert.equal(new Set(f.requests.slice(1).map(value => value.headers["webhook-id"])).size, 1);
  assert.equal(new Set(f.requests.slice(1).map(value => value.body)).size, 1);
  assert.notEqual(f.requests[1].headers["webhook-signature"], f.requests[2].headers["webhook-signature"]);
  assert.equal((await f.storage.list({ prefix: "environment-event-queue:" })).size, 0);
  for (const status of [410, 413]) {
    const one = fixture(); await one.events.subscribe("1", grant, input, initial);
    one.setDeliver(async () => result(status)); await one.events.flush();
    assert.equal((await one.storage.list({ prefix: "environment-event-queue:" })).size, 0);
  }
  const failedAuth = fixture(); await failedAuth.events.subscribe("1", grant, input, initial);
  failedAuth.setAuthorize(async () => { throw new Error("PRIVATE_LOOKUP_ERROR"); });
  for (let index = 0; index < 5; index++) { await failedAuth.events.flush(); failedAuth.advance(10 * 60000); }
  assert.equal(failedAuth.requests.length, 1);
  assert.equal((await failedAuth.storage.list({ prefix: "environment-event-queue:" })).size, 0);
});

test("revocation, delayed authorization and late HTTP replies cannot send or erase newer work", async () => {
  const f = fixture(); await f.events.subscribe("1", grant, input, initial);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>();
  f.setAuthorize(async () => { started.resolve(); return release.promise; });
  const flush = f.events.flush(); await started.promise;
  await f.events.unsubscribe("1", input); release.resolve(true); await flush;
  assert.equal(f.requests.length, 1);
  const r = fixture(); await r.events.subscribe("1", grant, input, initial);
  r.setAllowed(false); await r.events.flush();
  assert.equal(r.requests.length, 1);
  assert.equal((await r.storage.list({ prefix: "environment-event-sub:" })).size, 0);
  const d = fixture(); const original = await d.events.subscribe("1", grant, input, initial);
  const sent = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
  d.setDeliver(async request => { d.requests.push(request); sent.resolve(); await reply.promise; return result(200); });
  const oldDelivery = d.events.flush(); await sent.promise;
  const rotated = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  await d.events.subscribe("1", grant, { ...input, delivery: { ...input.delivery, secret: rotated } }, initial);
  reply.resolve(); await oldDelivery;
  assert.equal((await d.storage.list({ prefix: "environment-event-queue:" })).size, 1);
  d.setDeliver(async request => { d.requests.push(request); return result(200); });
  d.advance(31000); await d.events.flush();
  const delivery = d.requests.at(-1)!;
  assert.equal(delivery.headers["x-mcp-subscription-id"], original.id);
  assert.equal(delivery.headers["webhook-signature"].split(" ").length, 2);
  assert.doesNotThrow(() => new Webhook(rotated).verify(delivery.body, delivery.headers));
  assert.doesNotThrow(() => new Webhook(secret).verify(delivery.body, delivery.headers));
});

test("draft schema rejects unknown filters, malformed secrets and non-HTTPS callbacks", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "events/subscribe", params: input };
  assert.ok(eventRequestSchema.safeParse(request).success);
  for (const params of [{ ...input, arguments: { environmentId, extra: "PRIVATE" } },
    { ...input, delivery: { ...input.delivery, url: "http://receiver.example" } },
    { ...input, delivery: { ...input.delivery, secret: "whsec_YQ==" } },
    { ...input, delivery: { ...input.delivery, secret: "whsec_!!!!" } }]) {
    assert.equal(eventRequestSchema.safeParse({ ...request, params }).success, false);
  }
});
