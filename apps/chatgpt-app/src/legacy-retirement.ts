import { WorkerEntrypoint } from "cloudflare:workers";
import type { TaskRuntimeObject } from "./task-runtime-object.ts";

/** Temporary #145 operator RPC. No fetch handler or public route; remove at retirement. */
export class LegacyRetirement extends WorkerEntrypoint<{ TASKS: DurableObjectNamespace<TaskRuntimeObject> }> {
  async inspect(objectId: string) {
    return await this.env.TASKS.get(this.env.TASKS.idFromString(objectId)).retirementMetadata();
  }
}
