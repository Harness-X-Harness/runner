import { DurableObject } from "cloudflare:workers";

import {
  applyTaskEvent,
  claimTaskDispatch,
  commitTaskDispatch,
  publicTask,
} from "./task.js";
import {
  appendTaskStatusEvent,
  appendTaskStreamEvents,
  taskStreamIsTruncated,
  taskStreamTokenMatches,
} from "./task-stream.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const encoder = new TextEncoder();

export class TaskObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.subscribers = new Set();
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }

  async handle(request) {
    const url = new URL(request.url);
    const task = /** @type {Record<string, any> | undefined} */ (
      await this.ctx.storage.get("task")
    );

    if (request.method === "POST" && url.pathname === "/task") {
      const next = await request.json();
      const stream = appendTaskStatusEvent(emptyStream(), next);
      await this.ctx.storage.put({
        task: next,
        streamNextSeq: stream.state.nextSeq,
        streamEvents: stream.state.events,
      });
      this.broadcast(stream.appended, next);
      return json(next, 201);
    }

    if (request.method === "GET" && url.pathname === "/task") {
      return task ? json(task) : json({ error: "task not found" }, 404);
    }

    if (request.method === "PATCH" && url.pathname === "/task") {
      if (!task) return json({ error: "task not found" }, 404);
      const next = applyTaskEvent(task, await request.json());
      if (next === task) return json(task);
      const stream = appendTaskStatusEvent(await this.streamState(), next);
      await this.ctx.storage.put({
        task: next,
        streamNextSeq: stream.state.nextSeq,
        streamEvents: stream.state.events,
      });
      this.broadcast(stream.appended, next);
      return json(next);
    }

    if (request.method === "POST" && url.pathname === "/task/claim-dispatch") {
      if (!task) return json({ error: "task not found" }, 404);
      const { repositoryAccess } = await request.json();
      const result = claimTaskDispatch(task, repositoryAccess);
      if (result.claimed) {
        const stream = appendTaskStatusEvent(await this.streamState(), result.task);
        await this.ctx.storage.put({
          task: result.task,
          streamNextSeq: stream.state.nextSeq,
          streamEvents: stream.state.events,
        });
        this.broadcast(stream.appended, result.task);
      }
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/task/commit-dispatch") {
      if (!task) return json({ error: "task not found" }, 404);
      const next = commitTaskDispatch(task);
      if (next !== task) {
        const stream = appendTaskStatusEvent(await this.streamState(), next);
        await this.ctx.storage.put({
          task: next,
          streamNextSeq: stream.state.nextSeq,
          streamEvents: stream.state.events,
        });
        this.broadcast(stream.appended, next);
      }
      return json(next);
    }

    if (request.method === "POST" && url.pathname === "/task/stream-events") {
      if (!task) return json({ error: "task not found" }, 404);
      const { events } = await request.json();
      const stream = appendTaskStreamEvents(await this.streamState(), events, {
        terminal: TERMINAL_STATUSES.has(task.status),
      });
      if (stream.appended.length > 0) {
        await this.ctx.storage.put({
          streamNextSeq: stream.state.nextSeq,
          streamEvents: stream.state.events,
        });
        this.broadcast(stream.appended, task);
      }
      return json({ accepted: stream.appended.length });
    }

    if (request.method === "GET" && url.pathname === "/task/stream") {
      if (!task) return json({ error: "task not found" }, 404);
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!taskStreamTokenMatches(token, task.streamToken)) {
        return json({ error: "task stream authorization required" }, 401);
      }
      return this.openStream(task, await this.streamState(), Number(url.searchParams.get("after") ?? 0));
    }

    if (request.method === "GET" && url.pathname === "/task/public") {
      return task ? json(publicTask(task)) : json({ error: "task not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  }

  async streamState() {
    const values = await this.ctx.storage.get(["streamNextSeq", "streamEvents"]);
    return {
      nextSeq: values.get("streamNextSeq") ?? 1,
      events: values.get("streamEvents") ?? [],
    };
  }

  openStream(task, streamState, after) {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const events = streamState.events.filter((event) => event.seq > cursor);
    const oldestSeq = streamState.events[0]?.seq ?? streamState.nextSeq;
    let subscriber;
    const body = new ReadableStream({
      start: (controller) => {
        controller.enqueue(line({
          type: "snapshot",
          task: publicTask(task),
          events,
          truncated: taskStreamIsTruncated(cursor, oldestSeq),
        }));
        if (TERMINAL_STATUSES.has(task.status)) {
          controller.close();
          return;
        }
        subscriber = {
          controller,
          cursor: events.at(-1)?.seq ?? cursor,
        };
        this.subscribers.add(subscriber);
      },
      cancel: () => {
        if (subscriber) this.subscribers.delete(subscriber);
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    });
  }

  broadcast(events, task) {
    const terminal = TERMINAL_STATUSES.has(task.status);
    for (const subscriber of this.subscribers) {
      try {
        for (const event of events) {
          if (event.seq <= subscriber.cursor) continue;
          subscriber.controller.enqueue(line(event));
          subscriber.cursor = event.seq;
        }
        if (terminal) {
          subscriber.controller.close();
          this.subscribers.delete(subscriber);
        }
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }
}

function emptyStream() {
  return { nextSeq: 1, events: [] };
}

function line(value) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
