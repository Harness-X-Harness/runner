import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { z } from "zod";

export const environmentCreationInput = z.object({
  environmentId: z.string().regex(/^env_[a-f0-9]{32}$/),
  ownerId: z.string().regex(/^[1-9]\d{0,19}$/),
  executor: z.enum(["codex", "grok"]),
}).strict();
const recordSchema = environmentCreationInput.extend({
  createdAt: z.number().int().nonnegative(),
  admitUntil: z.number().int().positive(),
});
export type EnvironmentCreationRecord = z.infer<typeof recordSchema>;
type Storage = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
const KEY = "environment-creation";

/** One Environment's immutable identity. The caller selects its durable object ID. */
export class EnvironmentCreation {
  private readonly storage: Storage;
  private readonly startupMs: number;
  private readonly now: () => number;
  constructor(storage: Storage, startupMs: number, now = Date.now) {
    if (!Number.isSafeInteger(startupMs) || startupMs <= 0) throw new Error("INVALID_STARTUP_BUDGET");
    this.storage = storage;
    this.startupMs = startupMs;
    this.now = now;
  }

  async create(value: unknown): Promise<EnvironmentCreationRecord> {
    const input = environmentCreationInput.parse(value);
    return this.storage.transaction(async () => {
      const stored = await this.storage.get(KEY);
      if (stored !== undefined) {
        const record = recordSchema.parse(stored);
        if (record.ownerId !== input.ownerId || record.environmentId !== input.environmentId ||
            record.executor !== input.executor) throw new Error("ENVIRONMENT_CREATION_CONFLICT");
        return record;
      }
      const createdAt = this.now();
      const record = recordSchema.parse({ ...input, createdAt, admitUntil: createdAt + this.startupMs });
      await this.storage.put(KEY, record);
      return record;
    });
  }

  async read(ownerId: string): Promise<EnvironmentCreationRecord> {
    const record = await this.find(ownerId);
    if (!record) throw new Error("ENVIRONMENT_NOT_FOUND");
    return record;
  }

  async find(ownerId: string): Promise<EnvironmentCreationRecord | null> {
    const stored = await this.storage.get(KEY);
    if (stored === undefined) return null;
    const record = recordSchema.parse(stored);
    return record.ownerId === ownerId ? record : null;
  }

  /** Local lifecycle work (alarms), never a public authorization bypass. */
  async readInternal(): Promise<EnvironmentCreationRecord> {
    const stored = await this.storage.get(KEY);
    if (stored === undefined) throw new Error("ENVIRONMENT_NOT_FOUND");
    return recordSchema.parse(stored);
  }
}
