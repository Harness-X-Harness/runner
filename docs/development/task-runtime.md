# Native Agent Runtime

The internal `AgentRuntime` accepts one prompt and working directory and returns
`{ finalResponse }`. `close()` is idempotent and bounded. It does not clone a
repository, manage GitHub authorization, create branches or pull requests, or
own Task state. The caller owns those concerns.

The two provider clients and JSON-RPC process transport live in
[agent-runtime](../../.github/actions/agent-runtime/). Both the one-shot runtime
and the current Session adapters use these clients. Session IDs, controllers,
queues, event output and product transitions remain outside the clients.

Codex App Server omits the JSON-RPC version member on its wire envelopes; Grok
ACP uses JSON-RPC 2.0. Each client configures its one transport contract, with
no protocol fallback. Codex's `thread/start.sandbox` uses `danger-full-access`,
while `turn/start.sandboxPolicy.type` uses `dangerFullAccess`. These are distinct
native schema fields, not a shared Harness sandbox string.

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
distinguish the owner from another caller. Payload bytes and numeric clock
values are omitted. A deadline-passed flag distinguishes an eligible first
claim from an expired one; an admitted execution can still repeat its claim
after that startup deadline. Byte bounds and retention have fixed-clock tests.

The model allows delayed, duplicate and absent claim/finish operations and
stuttering. No fairness rule assumes that GitHub or a provider returns. It checks
single execution admission, no prompt release after pre-claim cancellation,
terminal immutability, prompt deletion and owner/binding gates. Fault configs
deliberately permit a post-cancel claim or terminal overwrite; they must violate
`NoPromptAfterCancel` or `TerminalImmutable`, respectively. A third fault permits
the first claim after the startup deadline and must violate `NoLateFirstClaim`.
There are no symmetry
reductions or state constraints. Stuttering represents valid quiescence, not
deadlock freedom of the external system.

[Task state tests](../../tests/task-state.test.js) force the matching cancel/claim
and finish/cancel orders, foreign identities and identical/conflicting replay.
They also check private serialization, Unicode bounds, wait subscription and
seven-day expiry. These tests do not establish production OIDC, GitHub delivery,
provider authorization or unattended convergence after a lost finish.

The local workerd SQLite test checks the actual transaction/alarm API boundary.
`deleteAll` cannot run inside an explicit transaction. Expiry is checked there,
then the immutable expired terminal object is removed with `deleteAll` outside
it. Prompt deletion and terminal/alarm writes remain atomic. No legal callback
can change an expired terminal record in that interval.

## Runner callbacks

`POST /internal/tasks/:taskId/claim` and `/finish` accept a GitHub OIDC assertion
only in the Authorization header. The shared verifier checks RS256 signature,
issuer, canonical control-plane origin as audience and token lifetime. Task
admission additionally requires the configured runner repository, exact
`run-task.yml` workflow at the configured branch, `ref_protected: "true"`, a
`workflow_dispatch` event and a GitHub-hosted runner. The signed `actor_id` must
equal the Task owner. The domain then binds the exact run ID and attempt.

The [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
defines the identity claims. GitHub's
[OIDC example](https://github.com/github/actions-oidc-debugger#how-to-use-this-action)
also shows `ref_protected` as a string. This is a separate gate from the Task ID;
a workflow body cannot substitute a different owner or execution identity.

Claim returns only Task ID, executor and private prompt. Finish accepts final
text or a canonical failure and returns only the terminal status. Responses use
`Cache-Control: no-store`; endpoint code does not log request bodies, assertions,
headers or response data. The shared callback envelope bound is 1 MiB. A runner
must bound its final text before upload; the state layer also independently
enforces its 64 KiB retained-result limit. There is no callback secret, URL token
or WebSocket in this path.

## One workflow per Task

[run-task.yml](../../.github/workflows/run-task.yml) accepts only `task_id`.
It checks out the trusted runtime with credential persistence disabled, claims
the Task, installs the selected provider through its official current installer,
runs the Agent, then publishes a terminal result. GitHub bounds the job to sixty
minutes. There is no target-repository checkout or built-in branch/PR pipeline.
The Agent receives a private empty workspace and performs the prompt's work.

Only the execution step receives the `MINI_*` Repository Secrets and
`AGENT_GITHUB_TOKEN` as `GH_TOKEN`. It writes the selected CLI's native
`~/.codex/config.toml` or `~/.grok/config.toml`; the key remains an environment
reference. The child environment omits both Actions OIDC request variables and
the job's `GITHUB_TOKEN`. This is non-inheritance, not isolation from another
process running as the same user. The Agent intentionally has the fixed token's
repository rights; user OAuth authority is only for controlling the runner.

The [small Node Action](../../.github/actions/task-runtime/) handles private
protocol data, not installation orchestration. Its claim and result files use
0600 permissions inside a 0700 directory under `RUNNER_TEMP`. The workspace is
inside that directory; tool homes are not relocated. Only the validated provider
name is an Action output. Prompts, final text, credentials and protocol payloads
are not printed, placed in artifacts or added to run metadata.

Final text is bounded before upload using the same shared helper as the domain.
Finish uses a fresh OIDC assertion for each of at most three attempts. Each
attempt has a ten-second combined identity/delivery bound, with a one-second gap
between attempts. Only uncertain delivery is retried; a definitive rejection
stops it. The workflow's narrow finalizer runs only after a successful claim and
does not replace an earlier failing step. If setup never reached the Agent, it
reports `PROVIDER_UNAVAILABLE`. If delivery never succeeds, GitHub's eventual
terminal state is the evidence for later Task reconciliation, not log scraping.

## MCP and convergence

`run_task({executor, prompt})`, `wait_task({taskId, timeoutSeconds?})` and
`cancel_task({taskId})` require `tasks:manage` and the owning GitHub Principal.
The scoped GitHub App user token remains the only control-plane execution
authority. It is not the fixed Agent token. Discovery marks arbitrary Agent
work as destructive and open-world; wait is read-only. There is no Task widget,
cursor, event stream, listing, interactive continuation or automatic rerun.

Creation starts a ten-minute unclaimed deadline. One per-Task alarm expires
unclaimed work without a caller, subject to storage and alarm availability.
The claim gate also checks the deadline, so delayed alarms cannot release a
late prompt. Expiry becomes `DISPATCH_FAILED`, or `cancelled` if cancellation
intent was already committed. The same alarm handles seven-day terminal
retention; claim removes the startup alarm. Neither cancellation nor a repeat
read resets a deadline.

Dispatch sends only Task ID. A definitive rejection fails that Task. A network
failure, timeout or server error retains the queued Task for a late claim or
expiry; it never restores a dispatch budget. A new `run_task` call creates new
work and is not an idempotent retry of the previous call.

A nonzero wait and each cancellation of a known active execution query only
the bound GitHub repository/run/attempt using the caller's current authority.
An exact terminal run without an accepted finish becomes `EXECUTION_ENDED`,
`TASK_TIMEOUT` or `cancelled`; no provider result is reconstructed. Failed,
revoked, missing or mismatched observations leave the Task active and return a
safe actionable error. A native final response committed first remains final.
GitHub's cancellation API targets a run ID, not an attempt-specific compare-and-
swap; the request uses the bound run, while Task claim/finish reject all other
attempts. It is not a rollback of earlier Agent effects.

Wait holds the request for at most 25 seconds including its bounded GitHub
observation budget. Zero requests a stored snapshot only. A snapshot status is
passed internally into the wait gate so a transition between observation and
subscription cannot be lost. With no later caller or no valid user authority,
automatic running-Task convergence is not promised. GitHub still enforces the
job lifetime; there is no permanent observer or alternate identity.

## Legacy admission cutover

`LEGACY_DRAIN_MODE` disables new Environment/Session entry at MCP discovery,
workflow dispatch and Durable Object mutation/claim boundaries. Existing
owner-authorized Session reads and exact-run close remain for retained data.
Read snapshots advertise no mutation or stream capability. Cutover requires
that previously admitted legacy runs have ended; it does not preserve their
native channels. The [operations runbook](../runner-operations-runbook.md#legacy-drain)
owns the storage-retention and deployment preconditions.

[LegacyRetirement](../../formal/LegacyRetirement.tla) models reservation,
already-issued dispatch completion, retirement and credential admission as
separate actions. Dispatch can finish after retirement, but a claim at the
retired gate cannot release execution credentials. The fault configuration
allows that claim and must violate `NoLateLegacyAdmission`. This is a finite
safety model of the gate, not a proof of distributed deployment atomicity,
JavaScript refinement, data-retention expiry or external progress. There is no
fairness, symmetry reduction or state constraint. Principal and payload values
are omitted because this gate denies all legacy admission uniformly; existing
identity tests own authorization checks.

[Cutover tests](../../tests/legacy-drain.test.js) check actual MCP registration
and actual workerd SQLite reads and denied mutations. They keep old grant
authority distinct from Tasks. Production acceptance separately checks the
deployed catalogue, retained reads and one new Task using the same grant.
