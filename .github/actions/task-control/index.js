const fs = require("node:fs/promises");

async function main() {
  const operation = input("operation");
  const controlPlaneUrl = input("control-plane-url").replace(/\/$/, "");
  const taskId = input("task-id");
  const token = await getOidcToken(controlPlaneUrl);

  if (operation === "fetch") {
    const outputFile = input("output-file");
    const response = await request(controlPlaneUrl, `/internal/tasks/${taskId}`, token);
    const task = await response.json();
    if (task.status === "cancel_requested" || task.status === "cancelled") {
      throw new Error("Task was cancelled before the executor started");
    }
    await fs.writeFile(outputFile, task.prompt, { mode: 0o600 });
    await fs.chmod(outputFile, 0o600);
  } else if (operation === "event") {
    const body = { status: input("status") };
    const runId = input("run-id");
    if (runId) body.runId = runId;
    const resultFile = input("result-file");
    if (resultFile) body.result = JSON.parse(await fs.readFile(resultFile, "utf8"));
    await request(controlPlaneUrl, `/internal/tasks/${taskId}/events`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } else {
    throw new Error(`Unsupported task-control operation: ${operation}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
}

async function getOidcToken(audience) {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!response.ok) throw new Error(`GitHub OIDC token request failed with ${response.status}`);
  const token = (await response.json()).value;
  process.stdout.write(`::add-mask::${token}\n`);
  return token;
}

async function request(controlPlaneUrl, path, token, options = {}) {
  const response = await fetch(`${controlPlaneUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Task control-plane request failed with ${response.status}`);
  return response;
}
