import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

test("task-control action reads GitHub inputs whose names contain hyphens", async (t) => {
  let event;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/oidc?")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: "test-oidc-token" }));
      return;
    }

    const body = [];
    for await (const chunk of request) body.push(chunk);
    event = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(body).toString("utf8")),
    };
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    process.execPath,
    [".github/actions/task-control/index.js"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-request-token",
        INPUT_OPERATION: "event",
        "INPUT_CONTROL-PLANE-URL": origin,
        "INPUT_TASK-ID": "task-123",
        INPUT_STATUS: "running",
        "INPUT_RUN-ID": "456",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [exitCode] = await once(child, "exit");

  assert.equal(
    exitCode,
    0,
    `${Buffer.concat(stderr).toString("utf8")}${Buffer.concat(stdout).toString("utf8")}`,
  );
  assert.deepEqual(event, {
    method: "POST",
    url: "/internal/tasks/task-123/events",
    authorization: "Bearer test-oidc-token",
    body: { status: "running", runId: "456" },
  });
});
