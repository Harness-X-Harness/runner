import type { DurableObjectStorage } from "@cloudflare/workers-types";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
type Reservation = { environmentId: string; ownerId: string; released: boolean; admitUntil: number };
const KEY = "environment-admission";

/** Internal capacity authority. No workflow I/O or lifecycle copies in transactions. */
export class EnvironmentAdmission {
  private readonly storage: Storage;
  private readonly now: () => number;
  constructor(storage: Storage, now = Date.now) { this.storage = storage; this.now = now; }

  // admitUntil belongs to the immutable Environment creation record, not the client.
  async reserve(ownerId: string, environmentId: string, admitUntil: number): Promise<void> {
    if (!/^[1-9]\d{0,19}$/.test(ownerId) || !/^env_[a-f0-9]{32}$/.test(environmentId) ||
        !Number.isSafeInteger(admitUntil) || admitUntil <= 0) {
      throw new Error("INVALID_ENVIRONMENT_RESERVATION");
    }
    await this.storage.transaction(async () => {
      const now = this.now();
      if (admitUntil <= now) throw new Error("ENVIRONMENT_ADMISSION_EXPIRED");
      const records = (await this.storage.get<Reservation[]>(KEY) ?? [])
        .filter(record => !record.released || record.admitUntil > now);
      const existing = records.find(record => record.environmentId === environmentId);
      if (existing) {
        if (existing.ownerId !== ownerId) throw new Error("ENVIRONMENT_OWNER_MISMATCH");
        if (existing.admitUntil !== admitUntil) throw new Error("ENVIRONMENT_ADMISSION_CONFLICT");
        if (existing.released) throw new Error("ENVIRONMENT_RESERVATION_RELEASED");
        return;
      }
      const held = records.filter(record => !record.released);
      if (held.some(record => record.ownerId === ownerId)) throw new Error("ENVIRONMENT_OWNER_CAPACITY");
      if (held.length >= 4) throw new Error("ENVIRONMENT_GLOBAL_CAPACITY");
      // Bound the single stored value without evicting replay protection.
      if (records.length >= 256) throw new Error("ENVIRONMENT_RECEIPT_CAPACITY");
      records.push({ ownerId, environmentId, released: false, admitUntil });
      await this.storage.put(KEY, records);
    });
  }

  // Only the Environment authority may call this after stop or no-dispatch proof.
  // This storage primitive does not itself authenticate that evidence.
  async releaseConfirmed(ownerId: string, environmentId: string): Promise<void> {
    await this.storage.transaction(async () => {
      const records = await this.storage.get<Reservation[]>(KEY) ?? [];
      const record = records.find(item => item.environmentId === environmentId);
      // A previously released receipt may already have been collected.
      if (!record) return;
      if (record.ownerId !== ownerId) throw new Error("ENVIRONMENT_RESERVATION_NOT_FOUND");
      if (record.released) return;
      record.released = true;
      await this.storage.put(KEY, records);
    });
  }

  async list(ownerId: string): Promise<string[]> {
    if (!/^[1-9]\d{0,19}$/.test(ownerId)) throw new Error("INVALID_ENVIRONMENT_OWNER");
    const records = await this.storage.get<Reservation[]>(KEY) ?? [];
    return records.filter(record => record.ownerId === ownerId && !record.released)
      .map(record => record.environmentId);
  }

  /** Internal bounded event routing; never a public owner-discovery endpoint. */
  async held(): Promise<string[]> {
    return (await this.storage.get<Reservation[]>(KEY) ?? []).filter(record => !record.released)
      .map(record => record.environmentId);
  }
}
