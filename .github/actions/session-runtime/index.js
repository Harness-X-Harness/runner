const fs = require("node:fs/promises");
const path = require("node:path");
const { DriverRegistry } = require("./drivers.js");

const ENVIRONMENT_CHANNEL_PROTOCOL = "harness.environment.v1";

class SessionRuntime {
  constructor({ generation, send, execute }) {
    this.generation = generation;
    this.send = send;
    this.execute = execute;
    this.receipts = new Set();
    this.outbox = [];
  }

  setSend(send) {
    this.send = send;
    const pending = this.outbox;
    this.outbox = [];
    for (const message of pending) this.deliver(message);
  }

  disconnect() {
    this.send = undefined;
  }

  deliver(message) {
    if (!this.send) {
      this.outbox.push(message);
      return;
    }
    try {
      this.send(message);
    } catch {
      this.send = undefined;
      this.outbox.push(message);
    }
  }

  async receive(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || message.generation !== this.generation) return;
    if (message.type === "command") {
      await this.command(message.sessionId, message.command);
      return;
    }
    if (message.type === "commands" && Array.isArray(message.commands)) {
      for (const command of message.commands) {
        await this.command(command.sessionId, command);
      }
    }
  }

  async command(sessionId, command) {
    if (!validId(sessionId) || !validId(command?.commandId)) return;
    const receipt = `${sessionId}\0${command.commandId}`;
    if (!this.receipts.has(receipt)) {
      this.receipts.add(receipt);
      try {
        await this.execute(sessionId, command);
      } catch {
        this.deliver({
          type: "event",
          generation: this.generation,
          sessionId,
          event: {
            type: "error",
            data: {
              scope: "driver",
              code: "command_failed",
              message: "The Session command failed in the runner.",
            },
          },
        });
      }
    }
    this.deliver({
      type: "ack",
      generation: this.generation,
      sessionId,
      commandId: command.commandId,
    });
  }

  event(sessionId, event) {
    this.deliver({ type: "event", generation: this.generation, sessionId, event });
  }

  transition(sessionId, action) {
    this.deliver({ type: "transition", generation: this.generation, sessionId, action });
  }
}

function channelProtocols(token) {
  if (!token) throw new Error("GitHub OIDC token is required");
  return [ENVIRONMENT_CHANNEL_PROTOCOL, `oidc.${token}`];
}

async function main() {
  const controlPlaneUrl = input("control-plane-url").replace(/\/$/, "");
  const environmentId = input("environment-id");
  const descriptor = await privateDescriptor();
  let socket;
  let stopping = false;
  let runtime;
  const drivers = new DriverRegistry({
    emit: (sessionId, event) => runtime.event(sessionId, event),
    transition: (sessionId, action) => runtime.transition(sessionId, action),
  });
  runtime = new SessionRuntime({
    generation: environmentId,
    send: () => {},
    execute: (sessionId, command) => drivers.execute(sessionId, command),
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopping = true;
      drivers.stopAll();
      socket?.close(1000, "runner stopping");
    });
  }

  while (!stopping) {
    const token = await oidcToken(controlPlaneUrl);
    process.stdout.write(`::add-mask::${token}\n`);
    await prepareChannel(controlPlaneUrl, environmentId, token, descriptor);
    socket = new WebSocket(channelUrl(controlPlaneUrl, environmentId), channelProtocols(token));
    runtime.setSend((message) => socket.send(JSON.stringify(message)));
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.addEventListener("message", (event) => {
      runtime.receive(event.data).catch(() => socket.close(1011, "command failed"));
    });
    await opened(socket);
    await closed;
    runtime.disconnect();
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function privateDescriptor() {
  const directory = path.join(process.env.HOME, "private-runner-session", "t3code");
  const [t3Url, pairingUrl] = await Promise.all([
    read(path.join(directory, "t3-url")),
    read(path.join(directory, "pairing-url")),
  ]);
  process.stdout.write(`::add-mask::${t3Url}\n::add-mask::${pairingUrl}\n`);
  return {
    t3Url,
    pairingUrl,
    tailscaleHost: `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  };
}

async function prepareChannel(controlPlaneUrl, environmentId, token, descriptor) {
  const response = await fetch(
    `${controlPlaneUrl}/internal/environments/${encodeURIComponent(environmentId)}/channel`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(descriptor),
    },
  );
  if (!response.ok) throw new Error(`Environment channel preparation failed with ${response.status}`);
}

function channelUrl(controlPlaneUrl, environmentId) {
  const url = new URL(
    `/internal/environments/${encodeURIComponent(environmentId)}/channel`,
    controlPlaneUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Environment channel failed")), { once: true });
  });
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
}

async function read(file) {
  return (await fs.readFile(file, "utf8")).trim();
}

async function oidcToken(audience) {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!response.ok) throw new Error(`GitHub OIDC token request failed with ${response.status}`);
  return (await response.json()).value;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

module.exports = {
  ENVIRONMENT_CHANNEL_PROTOCOL,
  SessionRuntime,
  channelProtocols,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
