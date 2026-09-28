import assert from "node:assert/strict";
import type { DurableObjectTransaction } from "../../apps/chatgpt-app/node_modules/@cloudflare/workers-types/index.d.ts";

// The fake enforces transaction order and rollback, not Cloudflare I/O behavior.
export function taskStorage() {
  let values = new Map<string, unknown>();
  let alarm: number | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let inTransaction = false;

  async function get<T = unknown>(key: string): Promise<T | undefined>;
  async function get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async function get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    assert.ok(typeof key === "string", "unexpected multi-key read");
    return structuredClone(values.get(key)) as T | undefined;
  }
  async function put<T>(key: string, value: T): Promise<void>;
  async function put<T>(entries: Record<string, T>): Promise<void>;
  async function put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    assert.ok(typeof key === "string", "unexpected multi-key write");
    values.set(key, structuredClone(value));
  }
  const storage = {
    get, put,
    async deleteAll() {
      if (inTransaction) throw new Error("Cannot call deleteAll() within a transaction");
      values.clear(); alarm = undefined;
    },
    async setAlarm(value: number | Date) { alarm = Number(value); },
    async deleteAlarm() { alarm = undefined; },
    async getAlarm() { return alarm; },
    async transaction<T>(operation: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const before = structuredClone(values);
        const beforeAlarm = alarm;
        inTransaction = true;
        // Only transaction methods used by these tests are implemented here.
        try { return await operation(storage as unknown as DurableObjectTransaction); }
        catch (error) { values = before; alarm = beforeAlarm; throw error; }
        finally { inTransaction = false; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  return storage;
}
