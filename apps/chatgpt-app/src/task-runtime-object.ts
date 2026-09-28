import { DurableObject } from "cloudflare:workers";
import { TaskError } from "../../../shared/task-errors.ts";
import { TaskStore } from "./task-state.ts";
import { taskErrorResponse } from "./task-request.ts";
import { z } from "zod";

export class TaskRuntimeObject extends DurableObject<unknown> {
  readonly tasks: TaskStore;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.tasks = new TaskStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return taskErrorResponse(new TaskError("TASK_NOT_FOUND"));
    const operation = new URL(request.url).pathname;
    try {
      const input = z.record(z.string(), z.unknown()).parse(await request.json());
      let result: unknown;
      switch (operation) {
        case "/create": result = await this.tasks.create(input); break;
        case "/read": result = await this.tasks.read(input.ownerId); break;
        case "/control": result = await this.tasks.control(input.ownerId); break;
        case "/wait": result = await this.tasks.wait(input.ownerId, input.timeoutSeconds, input.observedStatus); break;
        case "/cancel": result = await this.tasks.cancel(input.ownerId); break;
        case "/claim": result = await this.tasks.claim(input); break;
        case "/finish": result = await this.tasks.finish(input.execution, input.finish); break;
        case "/dispatch-failed": result = await this.tasks.dispatchFailed(input.ownerId); break;
        case "/execution-ended": result = await this.tasks.executionEnded(input.ownerId, input.execution, input.conclusion); break;
        default: throw new TaskError("TASK_NOT_FOUND");
      }
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return taskErrorResponse(error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR"));
    }
  }

  async alarm() { await this.tasks.alarm(); }

  /** Temporary operator projection for #145; deliberately bypasses state maintenance. */
  async retirementMetadata() {
    const task = await this.ctx.storage.get<{ status: string; createdAt: string;
      finishedAt?: string; expiresAt?: number }>("task");
    if (!task) return null;
    return { status: task.status, createdAt: task.createdAt,
      finishedAt: task.finishedAt ?? null, expiresAt: task.expiresAt ?? null };
  }
}
