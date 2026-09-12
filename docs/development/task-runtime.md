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

## Task state

One server-generated Task ID contains 128 random bits and resolves to one
`TASKS` / `TaskRuntimeObject`. It is not an authorization credential. There is
no owner index or list API. User operations require the Task's owner; runner
operations require the same owner and one admitted GitHub run and attempt.

State starts at `queued`. A claim moves it to `running`. Cancellation records
`cancelling`, which rejects later claims, including same-run retries. Cancellation
is intent, not proof that GitHub stopped; an already admitted execution can still
finish first. `completed`, `failed` and `cancelled` are immutable. An identical
finish replay succeeds without extending retention; another execution or a
conflicting outcome is rejected. A SHA-256 digest distinguishes complete final
texts even when their retained prefixes match.

The shared [Task contract](../../shared/task-contract.js) owns these limits:

- Prompt: non-empty, at most 64 KiB in UTF-8; oversized input is rejected.
- Final response: non-empty, at most 64 KiB retained. Truncation ends at a
  complete Unicode code point and sets `truncated: true`.
- Error: canonical code, safe message and retryable, at most 1 KiB; arbitrary
  error messages are not retained.
- Wait: at most 25 seconds, returning on state change, terminal state or timeout.
- Terminal retention: seven days from the original terminal timestamp.

The terminal storage transaction deletes the prompt and schedules the expiry
alarm. Expiry clears the entire object, including its alarm. Reads also enforce
expiry if an alarm is delayed. Replays cannot renew it. Only trusted creation
code issues fresh random IDs, so callbacks cannot recreate expired Tasks and no
tombstone or global cleanup scan is needed. SQLite transactions and `deleteAll`
semantics follow the [Cloudflare storage contract](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Public snapshots contain only Task ID, executor, status, timestamps, optional
run URL and result/error. Owner identity, prompt, execution binding and replay
digest remain private. The bounded wait uses an in-memory notification, not a
Session, event log or stream. It subscribes before its first read.

## Lifecycle model boundary

[TaskLifecycle](../../formal/TaskLifecycle.tla) is a finite requirements model,
not a proof of JavaScript refinement or external delivery. Its consistency
boundary is each committed per-Task storage transaction. Three execution values
distinguish another run and a new attempt of the same run; two principals
distinguish the owner from another caller. Payloads and time are omitted because
the checked lifecycle properties depend on release, binding and terminal order,
not raw bytes or clock values. Bounds and expiry have separate fixed-clock tests.

The model allows delayed, duplicate and absent claim/finish operations and
stuttering. No fairness rule assumes that GitHub or a provider returns. It checks
single execution admission, no prompt release after pre-claim cancellation,
terminal immutability, prompt deletion and owner/binding gates. Fault configs
deliberately permit a post-cancel claim or terminal overwrite; they must violate
`NoPromptAfterCancel` or `TerminalImmutable`, respectively. There are no symmetry
reductions or state constraints. Stuttering represents valid quiescence, not
deadlock freedom of the external system.

[Task state tests](../../tests/task-state.test.js) force the matching cancel/claim
and finish/cancel orders, foreign identities and identical/conflicting replay.
They also check private serialization, Unicode bounds, wait subscription and
seven-day expiry. These tests do not establish production OIDC, GitHub delivery,
provider authorization or unattended convergence after a lost finish.
