import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { Miniflare } from "../apps/chatgpt-app/node_modules/miniflare/dist/src/index.js";
import { TASK_LIMITS, newTaskId } from "../shared/task-contract.js";

test("Task storage transactions, alarms and expiry run on local workerd SQLite", async (t) => {
  const source = fileURLToPath(new URL("../apps/chatgpt-app/src/task-runtime-object.js", import.meta.url));
  const built = await build({
    stdin: { contents: `import { TaskRuntimeObject } from ${JSON.stringify(source)};
      export class TestedTask extends TaskRuntimeObject {
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/test/clock') {
            const now = Number(url.searchParams.get('now'));
            this.tasks.now = () => now;
            return new Response(null, { status: 204 });
          }
          if (url.pathname === '/test/state') return Response.json({
            task: await this.ctx.storage.get('task'), alarm: await this.ctx.storage.getAlarm()
          });
          return super.fetch(request);
        }
      }`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: "2026-07-23", durableObjects: { TASKS: { className: "TestedTask", useSQLite: true } },
    cf: false,
  });
  t.after(() => mf.dispose());
  const namespace = await mf.getDurableObjectNamespace("TASKS");
  const taskId = newTaskId();
  const stub = namespace.get(namespace.idFromName(taskId));
  const call = (operation, input) => stub.fetch(`http://task${operation}`, {
    method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" },
  });
  const now = Date.now();
  await stub.fetch(`http://task/test/clock?now=${now}`);
  assert.equal((await call("/create", { taskId, ownerId: "123", repository: "example/runner",
    executor: "codex", prompt: "PRIVATE_PROMPT" })).status, 200);
  const initial = await (await stub.fetch("http://task/test/state")).json();
  assert.equal(initial.alarm, now + TASK_LIMITS.startupMs);
  await stub.fetch(`http://task/test/clock?now=${now + TASK_LIMITS.startupMs}`);
  assert.equal((await call("/claim", { ownerId: "123", repository: "example/runner", runId: "900", runAttempt: "1" })).status, 409);
  const terminal = await (await stub.fetch("http://task/test/state")).json();
  assert.equal(terminal.task.status, "failed");
  assert.equal(terminal.task.prompt, undefined);
  assert.equal(terminal.alarm, now + TASK_LIMITS.startupMs + TASK_LIMITS.retentionMs);
  await stub.fetch(`http://task/test/clock?now=${terminal.alarm}`);
  const expired = await call("/read", { ownerId: "123" });
  assert.equal(expired.status, 404);
  assert.deepEqual(await (await stub.fetch("http://task/test/state")).json(), { alarm: null });
});
