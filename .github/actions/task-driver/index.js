const fs = require("node:fs/promises");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

async function main() {
  const executor = input("executor");
  const promptFile = input("prompt-file");
  const resultFile = input("result-file");
  const cwd = input("working-directory");
  const controlPlaneUrl = input("control-plane-url").replace(/\/$/, "");
  const taskId = input("task-id");
  const token = await getOidcToken(controlPlaneUrl);
  const publisher = eventPublisher((events) => request(
    controlPlaneUrl,
    `/internal/tasks/${encodeURIComponent(taskId)}/stream`,
    token,
    { method: "POST", body: JSON.stringify({ events }) },
  ));

  if (executor === "codex") {
    await runCodex({ cwd, promptFile, resultFile, publisher });
  } else if (executor === "grok") {
    await runGrok({ cwd, promptFile, resultFile, publisher });
  } else {
    throw new Error(`Unsupported streaming task driver: ${executor}`);
  }
  await publisher.finish();
}

async function runCodex({ cwd, promptFile, resultFile, publisher }) {
  const prompt = await fs.readFile(promptFile);
  const child = spawn("codex", [
    "exec",
    "--ephemeral",
    "--sandbox", "workspace-write",
    "--json",
    "--output-last-message", resultFile,
    "-",
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  child.stdin.end(prompt);
  await consumeLines(child, (value) => {
    const event = codexPublicEvent(value);
    if (event) publisher.add(event);
  }, "Codex");
  await fs.chmod(resultFile, 0o600);
}

async function runGrok({ cwd, promptFile, resultFile, publisher }) {
  const child = spawn("grok", [
    "--no-auto-update",
    "--always-approve",
    "-m", "mini-grok-4-6",
    "--output-format", "streaming-json",
    "--prompt-file", promptFile,
  ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  let result = { text: "", afterTool: false };
  await consumeLines(child, (value) => {
    result = updateGrokResult(result, value);
    const event = grokPublicEvent(value);
    if (event) publisher.add(event);
  }, "Grok");
  await fs.writeFile(resultFile, result.text, { mode: 0o600 });
  await fs.chmod(resultFile, 0o600);
}

async function consumeLines(child, receive, name) {
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    receive(JSON.parse(line));
  }
  const code = await closed;
  if (code !== 0) throw new Error(`${name} exited with ${code}`);
}

function codexPublicEvent(value) {
  if (value?.type === "item.completed" && value.item?.type === "agent_message" && value.item.text) {
    return message("message", value.item.text);
  }
  if (!["item.started", "item.completed"].includes(value?.type)) return undefined;
  const labels = {
    command_execution: value.type === "item.started" ? "Running a command" : "Command finished",
    file_change: value.type === "item.started" ? "Updating files" : "File changes finished",
    mcp_tool_call: value.type === "item.started" ? "Calling an MCP tool" : "MCP tool call finished",
    web_search: value.type === "item.started" ? "Searching the web" : "Web search finished",
    plan: value.type === "item.started" ? "Updating the plan" : "Plan updated",
  };
  const label = labels[value.item?.type];
  return label ? activity(label, value.type === "item.started" ? "running" : "completed") : undefined;
}

function grokPublicEvent(value) {
  if (value?.type === "text" && typeof value.data === "string" && value.data) {
    return message("message_delta", value.data);
  }
  if (value?.type === "tool_call") {
    return activity(cleanLabel(value.title || value.kind || "Using a tool"), "running");
  }
  if (value?.type === "tool_call_update") {
    return activity("Tool call finished", value.status === "failed" ? "failed" : "completed");
  }
  if (value?.type === "error") return activity("Grok reported an error", "failed");
  return undefined;
}

function updateGrokResult(state, value) {
  if (value?.type === "tool_call") return { ...state, afterTool: true };
  if (value?.type !== "text" || typeof value.data !== "string") return state;
  return {
    text: (state.afterTool ? "" : state.text) + value.data,
    afterTool: false,
  };
}

function message(type, text) {
  return { type, data: { text: String(text).slice(0, 8192) } };
}

function activity(label, status) {
  return { type: "activity", data: { label: cleanLabel(label), status } };
}

function cleanLabel(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 240) || "Activity";
}

function eventPublisher(publish) {
  let events = [];
  let timer;
  let failure;
  let chain = Promise.resolve();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (events.length === 0) return;
    const batch = events;
    events = [];
    chain = chain.then(() => publish(batch)).catch((error) => { failure = error; });
  };

  return {
    add(event) {
      events.push(event);
      if (events.length >= 12) flush();
      else if (!timer) timer = setTimeout(flush, 500);
    },
    async finish() {
      flush();
      await chain;
      if (failure) throw failure;
    },
  };
}

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
  if (!response.ok) throw new Error(`Task stream request failed with ${response.status}`);
  return response;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { codexPublicEvent, grokPublicEvent, updateGrokResult, eventPublisher };
