// The fake enforces transaction order and rollback, not Cloudflare I/O behavior.
export function taskStorage() {
  let values = new Map();
  let alarm;
  let tail = Promise.resolve();
  let inTransaction = false;
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async deleteAll() {
      if (inTransaction) throw new Error("Cannot call deleteAll() within a transaction");
      values.clear(); alarm = undefined;
    },
    async setAlarm(value) { alarm = value; },
    async deleteAlarm() { alarm = undefined; },
    async getAlarm() { return alarm; },
    async transaction(operation) {
      const result = tail.then(async () => {
        const before = structuredClone(values);
        const beforeAlarm = alarm;
        inTransaction = true;
        try { return await operation(storage); }
        catch (error) { values = before; alarm = beforeAlarm; throw error; }
        finally { inTransaction = false; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  return storage;
}
