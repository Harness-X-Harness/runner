import { DurableObject } from "cloudflare:workers";
import { TaskError } from "../../../shared/task-errors.js";
import { TaskStore } from "./task-state.js";
import { taskErrorResponse } from "./task-request.js";

export class TaskRuntimeObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tasks = new TaskStore(ctx.storage);
  }

  async fetch(request) {
    if (request.method !== "POST") return taskErrorResponse(new TaskError("TASK_NOT_FOUND"));
    const operation = new URL(request.url).pathname;
    try {
      const input = await request.json();
      let result;
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
}
