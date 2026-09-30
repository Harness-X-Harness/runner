import { Webhook } from "standardwebhooks";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { WebhookDelivery, WebhookDeliveryResult } from "../../../shared/webhook-delivery.ts";
import { EVENT_NAME, EventError, type EventChange, type EventData, type GrantIdentity, type SubscribeInput, type UnsubscribeInput } from "./mcp-events.ts";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list" | "transaction" | "getAlarm" | "setAlarm">;
type Event = { eventId: string; name: typeof EVENT_NAME; timestamp: string; data: EventData; cursor: null };
type Subscription = { id: string; epoch: string; ownerId: string; grant: GrantIdentity; url: string; secret: string;
  previousKey?: { secret: string; until: number }; expiresAt: number; active: boolean; verifiedUntil?: number; lastRevision?: number };
type Pending = { subscriptionId: string; epoch: string; event: Event; attempts: number; nextAttempt: number };
type Dependencies = { deliver(input: WebhookDelivery): Promise<WebhookDeliveryResult>;
  allowed(grant: GrantIdentity): Promise<boolean>; now?: () => number };
const SUB = "environment-event-sub:";
const QUEUE = "environment-event-queue:";
const HOUR = 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 8;
const MAX_PENDING = 256;
const MAX_ATTEMPTS = 5;

async function identity(ownerId: string, input: UnsubscribeInput): Promise<string> {
  // Arguments have exactly one validated key, so this is canonical JSON.
  const bytes = new TextEncoder().encode(JSON.stringify([ownerId, input.delivery.url, input.name, input.arguments.environmentId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sub_${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function signed(subscription: Subscription, id: string, body: string, now: number): WebhookDelivery {
  const date = new Date(now);
  const signatures = [new Webhook(subscription.secret).sign(id, date, body)];
  if (subscription.previousKey && subscription.previousKey.until > now) {
    signatures.push(new Webhook(subscription.previousKey.secret).sign(id, date, body));
  }
  return { url: subscription.url, body, headers: { "webhook-id": id,
    "webhook-timestamp": String(Math.floor(now / 1000)), "webhook-signature": signatures.join(" "),
    "x-mcp-subscription-id": subscription.id } };
}
function matchesChallenge(body: string, challenge: string): boolean {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return false; }
  if (!value || typeof value !== "object" || !("challenge" in value) || typeof value.challenge !== "string") return false;
  const expected = new TextEncoder().encode(challenge), actual = new TextEncoder().encode(value.challenge);
  let difference = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ (actual[index] ?? 0);
  return difference === 0;
}

/** One Environment's subscriptions and bounded outbox. No business state lives here. */
export class EnvironmentEvents {
  private readonly storage: Storage;
  private readonly dependencies: Dependencies;
  private readonly now: () => number;
  constructor(storage: Storage, dependencies: Dependencies) {
    this.storage = storage; this.dependencies = dependencies; this.now = dependencies.now ?? Date.now;
  }

  async subscribe(ownerId: string, grant: GrantIdentity, input: SubscribeInput, initial: EventChange) {
    const id = await identity(ownerId, input);
    const epoch = crypto.randomUUID();
    const candidate = await this.storage.transaction(async () => {
      await this.prune();
      const old = await this.storage.get<Subscription>(SUB + id);
      if (!old && (await this.storage.list({ prefix: SUB })).size >= MAX_SUBSCRIPTIONS) {
        throw new EventError(-32013, "Subscription capacity reached", { limit: "subscriptions", max: MAX_SUBSCRIPTIONS });
      }
      const now = this.now();
      const verified = [...(await this.storage.list<Subscription>({ prefix: SUB })).values()]
        .find(value => value.ownerId === ownerId && value.url === input.delivery.url && (value.verifiedUntil ?? 0) > now);
      const record: Subscription = { id, epoch, ownerId, grant, url: input.delivery.url, secret: input.delivery.secret,
        active: false, expiresAt: now + Math.max(60000, Math.min(input.ttlMs ?? HOUR, 24 * HOUR)),
        lastRevision: old?.lastRevision,
        ...(verified ? { verifiedUntil: verified.verifiedUntil } : {}),
        ...(old?.active && old.secret !== input.delivery.secret
          ? { previousKey: { secret: old.secret, until: now + 60000 } } : {}),
      };
      // A refresh invalidates in-flight bookkeeping, but preserves pending events.
      await this.storage.put(SUB + id, record);
      for (const [key, pending] of await this.storage.list<Pending>({ prefix: QUEUE })) {
        if (pending.subscriptionId === id) await this.storage.put(key, { ...pending, epoch });
      }
      await this.wake(record.expiresAt);
      return { record, fresh: !old?.active };
    });
    try {
      if (!candidate.record.verifiedUntil) {
        const challenge = crypto.randomUUID();
        const result = await this.dependencies.deliver(signed(candidate.record, `msg_verification_${crypto.randomUUID()}`,
          JSON.stringify({ type: "verification", challenge }), this.now()));
        if (result.kind !== "response" || result.status < 200 || result.status >= 300 || !matchesChallenge(result.body, challenge)) {
          const reason = result.kind === "error" ? result.reason === "timeout" ? "timeout" : "connection_refused"
            : result.status >= 500 ? "http_5xx" : result.status >= 400 ? "http_4xx" : "challenge_failed";
          throw new EventError(-32015, "Callback verification failed", { reason });
        }
      }
      if (!await this.dependencies.allowed(grant)) throw new EventError(-32012, "Subscription permission was revoked");
      return await this.storage.transaction(async () => {
        const current = await this.storage.get<Subscription>(SUB + id);
        if (!current || current.epoch !== epoch || current.expiresAt <= this.now()) {
          throw new EventError(-32015, "Subscription changed during verification", { reason: "challenge_failed" });
        }
        const active = { ...current, active: true, verifiedUntil: candidate.record.verifiedUntil ?? this.now() + 10 * 60000 };
        await this.storage.put(SUB + id, active);
        const latest = await this.storage.get<Event>("environment-event-latest");
        if (candidate.fresh || (latest && latest.data.revision > (active.lastRevision ?? 0))) {
          const snapshot = latest ?? await this.newEvent(input.arguments.environmentId, initial);
          await this.enqueue(active, snapshot);
        }
        await this.wake(this.now() + 1);
        return { id, refreshBefore: new Date(active.expiresAt).toISOString(), cursor: null, truncated: false };
      });
    } catch (error) {
      await this.storage.transaction(async () => {
        if ((await this.storage.get<Subscription>(SUB + id))?.epoch === epoch) await this.remove(id);
      });
      if (error instanceof EventError) throw error;
      throw new EventError(-32015, "Callback verification unavailable", { reason: "connection_refused" });
    }
  }

  async unsubscribe(ownerId: string, input: UnsubscribeInput): Promise<void> {
    const id = await identity(ownerId, input);
    await this.storage.transaction(() => this.remove(id));
  }

  /** Called inside the transaction that commits the source change. */
  async publish(environmentId: string, change: EventChange): Promise<void> {
    const event = await this.newEvent(environmentId, change);
    await this.storage.put("environment-event-latest", event);
    for (const subscription of (await this.storage.list<Subscription>({ prefix: SUB })).values()) {
      if (subscription.active && subscription.expiresAt > this.now()) await this.enqueue(subscription, event);
    }
  }

  private async newEvent(environmentId: string, change: EventChange): Promise<Event> {
    const revision = (await this.storage.get<number>("environment-event-revision") ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("EVENT_REVISION_EXHAUSTED");
    await this.storage.put("environment-event-revision", revision);
    return { eventId: `evt_${crypto.randomUUID()}`, name: EVENT_NAME, timestamp: new Date(this.now()).toISOString(),
      data: { ...change, environmentId, revision }, cursor: null };
  }
  private async enqueue(subscription: Subscription, event: Event): Promise<void> {
    const queue = await this.storage.list<Pending>({ prefix: QUEUE });
    if (queue.size >= MAX_PENDING) {
      // Non-replayable notifications never block the business transaction.
      const oldest = [...queue].sort((a, b) => a[1].event.data.revision - b[1].event.data.revision)[0];
      await this.storage.delete(oldest[0]);
    }
    await this.storage.put(QUEUE + subscription.id + ":" + event.eventId,
      { subscriptionId: subscription.id, epoch: subscription.epoch, event, attempts: 0, nextAttempt: this.now() });
    await this.storage.put(SUB + subscription.id, { ...subscription, lastRevision: event.data.revision });
    await this.wake(this.now() + 1);
  }
  private async remove(id: string): Promise<void> {
    await this.storage.delete(SUB + id);
    for (const [key, pending] of await this.storage.list<Pending>({ prefix: QUEUE })) {
      if (pending.subscriptionId === id) await this.storage.delete(key);
    }
  }
  private async prune(): Promise<void> {
    for (const [key, subscription] of await this.storage.list<Subscription>({ prefix: SUB })) {
      if (subscription.expiresAt <= this.now()) await this.remove(key.slice(SUB.length));
    }
  }
  private async wake(at: number): Promise<void> {
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > at) await this.storage.setAlarm(at);
  }
  async nextAlarm(): Promise<number | undefined> {
    const subscriptions = await this.storage.list<Subscription>({ prefix: SUB });
    const times = [...subscriptions.values()].map(value => value.expiresAt);
    for (const pending of (await this.storage.list<Pending>({ prefix: QUEUE })).values()) {
      if (subscriptions.get(SUB + pending.subscriptionId)?.active) times.push(pending.nextAttempt);
    }
    return times.length ? Math.max(this.now() + 1, Math.min(...times)) : undefined;
  }

  async flush(): Promise<void> {
    await this.storage.transaction(() => this.prune());
    // One delivery per alarm bounds time spent away from lifecycle scheduling.
    // An interrupted attempt remains eligible after its persisted retry deadline.
    const batch = [...await this.storage.list<Pending>({ prefix: QUEUE })]
      .filter(([, value]) => value.nextAttempt <= this.now()).slice(0, 1);
    for (const [key, pending] of batch) {
      let subscription = await this.storage.get<Subscription>(SUB + pending.subscriptionId);
      if (!subscription?.active || subscription.epoch !== pending.epoch || subscription.expiresAt <= this.now()) continue;
      if (pending.attempts >= MAX_ATTEMPTS) { await this.finishAttempt(key, pending, true); continue; }
      // Consume before external work, including authorization lookup failures.
      const claimed = await this.storage.transaction(async () => {
        const current = await this.storage.get<Pending>(key);
        if (!current || current.epoch !== pending.epoch || current.attempts !== pending.attempts) return false;
        const nextAttempt = this.now() + 30000 * 2 ** current.attempts;
        await this.storage.put(key, { ...current, attempts: current.attempts + 1, nextAttempt });
        await this.wake(nextAttempt);
        return true;
      });
      if (!claimed) continue;
      let allowed: boolean;
      try { allowed = await this.dependencies.allowed(subscription.grant); }
      catch { await this.finishAttempt(key, pending, false); continue; }
      // Authorization I/O is a cut point: reread cancellation/rotation/expiry.
      subscription = await this.storage.get<Subscription>(SUB + pending.subscriptionId);
      if (!subscription?.active || subscription.epoch !== pending.epoch || subscription.expiresAt <= this.now()) continue;
      if (!allowed) {
        await this.storage.transaction(async () => {
          if ((await this.storage.get<Subscription>(SUB + pending.subscriptionId))?.epoch === pending.epoch) {
            await this.remove(pending.subscriptionId);
          }
        });
        continue;
      }
      // No await between this final authority snapshot and starting delivery.
      // An already-started HTTP request cannot be recalled by unsubscribe.
      let response: WebhookDeliveryResult;
      try { response = await this.dependencies.deliver(signed(subscription, pending.event.eventId, JSON.stringify(pending.event), this.now())); }
      catch { response = { kind: "error", reason: "network" }; }
      const done = response.kind === "response" &&
        ((response.status >= 200 && response.status < 300) || response.status === 410 || response.status === 413 ||
          (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429));
      await this.finishAttempt(key, { ...pending, attempts: pending.attempts + 1 }, done);
    }
  }
  private async finishAttempt(key: string, pending: Pending, done: boolean): Promise<void> {
    await this.storage.transaction(async () => {
      const current = await this.storage.get<Pending>(key);
      if (!current || current.epoch !== pending.epoch) return;
      if (done || current.attempts >= MAX_ATTEMPTS) await this.storage.delete(key);
    });
  }
}
