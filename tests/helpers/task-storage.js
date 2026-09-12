// The fake enforces transaction order and rollback, not Cloudflare I/O behavior.
export function taskStorage() {
  let values = new Map();
  let alarm;
  let tail = Promise.resolve();
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async deleteAll() { values.clear(); alarm = undefined; },
    async setAlarm(value) { alarm = value; },
    async deleteAlarm() { alarm = undefined; },
    async getAlarm() { return alarm; },
    async transaction(operation) {
      const result = tail.then(async () => {
        const before = structuredClone(values);
        const beforeAlarm = alarm;
        try { return await operation(storage); }
        catch (error) { values = before; alarm = beforeAlarm; throw error; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  return storage;
}
