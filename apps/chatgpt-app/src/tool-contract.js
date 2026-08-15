export const TOOL_CONTRACT = Object.freeze([
  Object.freeze({
    name: "submit_task",
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false,
  }),
  Object.freeze({
    name: "get_task",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  }),
  Object.freeze({
    name: "cancel_task",
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  }),
  Object.freeze({
    name: "get_task_result",
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  }),
]);
