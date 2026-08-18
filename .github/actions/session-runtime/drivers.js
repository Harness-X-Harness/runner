const { CodexDriver } = require("./codex-driver.js");
const { GrokDriver } = require("./grok-driver.js");

class DriverRegistry {
  constructor({ emit, transition, driverTypes = { codex: CodexDriver, grok: GrokDriver } }) {
    this.emit = emit;
    this.transition = transition;
    this.driverTypes = driverTypes;
    this.drivers = new Map();
  }

  async execute(sessionId, command) {
    let driver = this.drivers.get(sessionId);
    if (!driver) {
      if (command.kind !== "start" || command.payload?.initial !== true) {
        throw new Error("Session driver has not started");
      }
      const Driver = this.driverTypes[command.executor];
      if (!Driver) throw new Error("Session executor is unavailable");
      driver = new Driver({
        sessionId,
        workingDirectory: command.workingDirectory,
        emit: (event) => this.emit(sessionId, event),
        transition: (action) => this.transition(sessionId, action),
      });
      this.drivers.set(sessionId, driver);
      try {
        await driver.start(command.payload);
      } catch {
        const alreadyTerminated = driver.terminated;
        driver.stop();
        this.drivers.delete(sessionId);
        if (alreadyTerminated) return;
        this.emit(sessionId, {
          type: "error",
          data: {
            scope: "driver",
            code: "startup_failed",
            message: "The Session driver could not start.",
          },
        });
        this.transition(sessionId, { type: "terminate", reason: "driver_failed" });
      }
      return;
    }
    try {
      await driver.execute(command);
      if (command.kind === "stop") this.drivers.delete(sessionId);
    } catch {
      driver.stop();
      this.drivers.delete(sessionId);
      this.emit(sessionId, {
        type: "error",
        data: {
          scope: "driver",
          code: "command_failed",
          message: "The Session driver command failed.",
        },
      });
      this.transition(sessionId, { type: "terminate", reason: "driver_failed" });
    }
  }

  stopAll() {
    for (const driver of this.drivers.values()) driver.stop();
    this.drivers.clear();
  }
}

module.exports = { DriverRegistry };
