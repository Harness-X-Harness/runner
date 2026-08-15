import { DurableObject } from "cloudflare:workers";

import { applyTaskEvent, publicTask } from "./task.js";

export class TaskObject extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const task = await this.ctx.storage.get("task");

    if (request.method === "POST" && url.pathname === "/task") {
      const next = await request.json();
      await this.ctx.storage.put("task", next);
      return json(next, 201);
    }

    if (request.method === "GET" && url.pathname === "/task") {
      return task ? json(task) : json({ error: "task not found" }, 404);
    }

    if (request.method === "PATCH" && url.pathname === "/task") {
      if (!task) return json({ error: "task not found" }, 404);
      const next = applyTaskEvent(task, await request.json());
      await this.ctx.storage.put("task", next);
      return json(next);
    }

    if (request.method === "GET" && url.pathname === "/task/public") {
      return task ? json(publicTask(task)) : json({ error: "task not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
