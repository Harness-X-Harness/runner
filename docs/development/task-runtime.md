# Native Agent Runtime

The internal `AgentRuntime` accepts one prompt and working directory and returns
`{ finalResponse }`. `close()` is idempotent and bounded. It does not clone a
repository, manage GitHub authorization, create branches or pull requests, or
own Task state. The caller owns those concerns.

The two provider clients and JSON-RPC process transport live in
[agent-runtime](../../.github/actions/agent-runtime/). Both the one-shot runtime
and the current Session adapters use these clients. Session IDs, controllers,
queues, event output and product transitions remain outside the clients.

## Final response

- Codex: consume authoritative completed `agentMessage` items, exclude explicit
  `commentary`, and wait for success of the exact native turn. The optional
  `phase` field uses the documented `commentary` / `final_answer` values.
- Grok: use ACP text chunks within each model-response boundary. The xAI
  `response_completed` update ends one response; `session/prompt` success ends
  the operation. Return only the last completed response, not the concatenation
  of earlier commentary. Both documented xAI session-notification carriers are
  supported. Missing completion boundaries are a protocol error, not a reason
  to capture CLI stdout.

Native completion means the provider succeeded with non-empty final text. It
does not prove that the prompt's business objective succeeded. Progress,
reasoning, tool output, native identifiers and raw errors are not runtime results.

See the [Codex App Server protocol](https://developers.openai.com/codex/app-server)
and Grok's [native response notifications](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/notification.rs).

## Failure and cleanup

Command and file approvals follow the autonomous policy. New human questions
or MCP elicitation fail with `USER_INPUT_REQUIRED`; the runtime has no interactive
continuation. Provider startup, protocol and execution failures use the shared
[safe error definitions](../../shared/task-errors.js). Only code, safe message
and retryable are serialized. There is no provider or credential fallback.

The runtime closes its child after success or failure. Transport cleanup sends
SIGTERM, allows one second, then sends SIGKILL if the child has not exited.
The runtime's outer cleanup bound is 1.5 seconds; a cleanup failure cannot
replace the original result or error.
