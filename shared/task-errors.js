/** @type {Readonly<Record<string, [string, boolean]>>} */
const ERRORS = Object.freeze({
  PROVIDER_UNAVAILABLE: ["The selected provider could not start.", true],
  PROVIDER_PROTOCOL_ERROR: ["The provider returned an unsupported or invalid response.", false],
  PROVIDER_EXECUTION_ERROR: ["The provider could not complete the task.", false],
  USER_INPUT_REQUIRED: ["The task needs new human input. Submit a new task with that information.", false],
});

class TaskError extends Error {
  constructor(code) {
    const definition = ERRORS[code];
    if (!definition) throw new TypeError("Unknown Task error code");
    super(definition[0]);
    this.code = code;
    this.retryable = definition[1];
  }

  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable }; }
}

module.exports = { TaskError };
