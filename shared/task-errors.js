/** @type {Readonly<Record<string, [string, boolean]>>} */
const ERRORS = Object.freeze({
  INVALID_TASK_INPUT: ["The task input is invalid or exceeds a supported limit.", false],
  TASK_NOT_FOUND: ["The task was not found or is no longer available.", false],
  TASK_AUTH_REQUIRED: ["Reconnect with tasks:manage and valid GitHub runner authorization.", false],
  GITHUB_UNAVAILABLE: ["GitHub could not confirm this runner operation. Check repository access and try again.", true],
  DISPATCH_FAILED: ["The task workflow could not be started. Check GitHub runner access before submitting a new task.", true],
  CLAIM_REJECTED: ["This execution cannot claim or finish the task.", false],
  PROVIDER_UNAVAILABLE: ["The selected provider could not start.", true],
  PROVIDER_PROTOCOL_ERROR: ["The provider returned an unsupported or invalid response.", false],
  PROVIDER_EXECUTION_ERROR: ["The provider could not complete the task.", false],
  USER_INPUT_REQUIRED: ["The task needs new human input. Submit a new task with that information.", false],
  TASK_TIMEOUT: ["The task exceeded its execution time limit.", false],
  EXECUTION_ENDED: ["The workflow ended without a task result.", false],
  CANCELLED: ["The task was cancelled. Earlier external changes are not rolled back.", false],
  INTERNAL_ERROR: ["The task service could not complete this operation.", true],
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
