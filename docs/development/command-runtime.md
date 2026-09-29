# Direct command runtime

`runCommand` in `.github/actions/agent-runtime/command.ts` is a runner-local
primitive. It is not registered as an MCP tool and does not dispatch workflows.
It uses Node's process API, not an Agent or a shell wrapper.

The public `command` tool reaches this primitive through the Environment Task
authority and its authenticated runner connection, authorized by `environments:use`.
The tool schema requires `environmentId`, nonempty `argv` and a positive
`timeoutSeconds`; `cwd` defaults to the workspace. Tool schemas in
`environment-tools.ts` share the service validators and are the input authority.

The caller supplies a workspace, an absolute deadline derived from the remaining
runtime budget, an abort signal and explicit environment fields. The command
supplies argv, an optional cwd and a relative timeout. The earlier deadline wins.
Relative cwd resolves from the workspace; real paths outside it are rejected.
Commands can still access other files: this is not a security sandbox.

Only PATH, HOME, TMPDIR and the approved GH_TOKEN are projected into the child.
No ambient process environment is inherited. Native configuration files in HOME
remain accessible to the same runner user.

The result preserves the exit code, terminating signal, separate stdout/stderr,
truncation and any cancellation/timeout intent. A nonzero exit code is a command
result, not a transport failure. Combined captured bytes and returned UTF-8 text
are bounded to 64 KiB. Output is drained without forwarding it to workflow logs.

The Environment output resource is separate from the semantic final result.
`EnvironmentOutput` retains a 64 KiB UTF-8 prefix per admitted operation, a
monotonic revision and an explicit truncation flag. Once truncated, later chunks
do not fill holes in that prefix. ACP contributes only same-session text from
`agent_message_chunk`; thoughts, tool RPC data and native metadata are excluded.
Commands contribute stdout/stderr text in observed arrival order with independent
incremental UTF-8 decoders. Their final result still keeps stdout/stderr separate.
Read or reconnect replaces a snapshot; it does not append the same text again.

The existing generation-bound runner connection sends output snapshots with at
most one unacknowledged output frame. Changes during that acknowledgement wait
coalesce into the latest snapshot. Reconnect reuses process-owned receipts;
final result delivery carries the final snapshot so both commit atomically.
The Environment Object rejects conflicting revisions and changes after the
final result; old replayed output cannot roll its stored snapshot back. Output
does not change Task status or emit Task progress notifications.

The Environment Resource handler serves owner-checked
`harness://tasks/{taskId}/output`. A known URI is readable while that operation
record remains stored; this does not add a historical output catalog. The Environment
MCP handler accepts standard `subscriptions/listen` resource filters for output
URIs. It sends `notifications/resources/updated` with the URI only; the client
then reads the current snapshot. Each delivery checks current authorization and
the original owner. Task filters still require the Tasks capability; output-only
resource filters do not. Subscription registration precedes snapshot reading,
including an initial current-snapshot event. Output and Task status observers
share the same event-driven read mechanism, not the same notification payload.

Environment lifecycle resources use this same subscription path, including
control-plane deadline alarms that commit close intent. Closed-Environment content
expires after seven days using the same native alarm; expiry denies reads and
deletes stored operation/output content. The Worker mounts this handler at `/mcp`
for Environment grants. Protocol support does not imply that every host can
display resources or resume its model after a Task notification. A client that
declares Tasks uses Task handles for these tools. A client that does not
declare Tasks receives an ordinary acceptance receipt and can read
`inspect_environment` once. That path does not poll, subscribe, or turn a
failed call into the other contract. Task subscription filters still require
the Tasks capability.

The POSIX child has its own process group. Cancellation and timeout send SIGKILL;
normal leader exit also stops remaining group members. Result delivery waits for
Node's close event, not just a signal send or exit event. Deliberately detached
descendants are outside this primitive's cleanup guarantee and require full
Environment teardown. The OS may delay exit or stream closure; this function does
not turn a missing observation into a successful stop. Windows is unsupported.

`EnvironmentRuntime` in `environment-runtime.ts` owns one local execution slot
shared by command and Agent turns, reserved before any asynchronous
cwd lookup or prompt send. A second operation is rejected as busy rather than queued. `close()`
seals admission synchronously, cancels the active command and waits for its
settlement; repeated close returns the same promise. Invalid input releases the
slot. Unconfirmed process-group cleanup seals the runtime and rejects close;
the Environment owner must retain teardown responsibility. A successful local
close is not proof that the GitHub run or entire Environment has stopped.

Agent turns use the supplied SDK session and client; the Environment caller must
bind these to its own workspace and provider. The slot stays occupied until both
the prompt response and SDK update consumer finish. Native cancellation returns
a cancelled result and permits the next turn. Closing sends standard ACP cancel
and waits for that result; it does not claim that the enclosing provider process
has exited. Unknown Agent termination seals admission. The enclosing
`withAcpAgent` scope still owns process teardown.

Environment admission, durable operation identity and delivery, authorization
and standard MCP Tasks belong to the caller and are not implemented here.

`EnvironmentLifetime` owns one runner-local absolute deadline and a shutdown
callback. Expiry and explicit close synchronously abort the same signal and run
that callback once. Its `stopped` promise resolves only after callback completion
and preserves cleanup failure. It also expires while idle, without polling or a
new command. The owner must use its signal to seal admission and compose cleanup
of every owned runtime and transport. `withEnvironment` in `environment.ts`
composes this lifetime with the shared slot and one ACP session. It binds both
command and Agent to the process workspace and checks lifetime admission before
forwarding calls. Its serving callback must stop receiving on abort and finish
its pending delivery. The outer function awaits slot cleanup and ACP process
exit; the port's close method alone confirms only slot cleanup. Deadline expiry
during startup aborts the handshake. Local tests cover shared cwd, explicit close,
idle expiry and expiry during a cancellable native turn, with OS process readback.
A provider that never confirms
turn cancellation can still prevent local cleanup completion. This
timer cannot guarantee a hard wall-clock stop if the Node event loop or OS stalls;
the external job budget remains the outer containment boundary.

The existing `withAcpAgent` scope can own multiple prompts on one SDK session;
it need not be recreated for each turn. It rejects an already aborted lifetime
signal before spawning a process. Controlled ACP tests exercise two sequential
turns in the same native session and verify process exit after leaving the
scope. This is protocol-fixture evidence, not a real model continuity or turn
cancellation acceptance result.

Agent model selection is applied to that same session with
`session/set_config_option` before the prompt. Candidate rejection happens
before any option is sent, so another agent call can correct it. Once an option
request has started and the full pair is not confirmed, the runtime marks the
Agent configuration uncertain and rejects every later agent prompt. It does not
roll back, retry, or infer that the untouched default is still active. Command
and close remain available. The local fault injection is not production
evidence that a provider has failed this way.

`readAgentTurn` consumes SDK updates through the native stop marker and returns
either a completed semantic final response or cancellation. It does not cancel
the prompt request locally, close the session, or infer stopped work from a sent
cancel notification. A controlled test sends standard `session/cancel`, awaits
the native cancelled response and queue stop marker, then completes another turn
in the same session and process. Durable turn identity,
control-plane admission and user-input routing belong to the Environment authority,
not this final-response reader. Native provider cancellation remains a distinct
boundary from the ACP fixture's cancellation behavior.

`withEnvironment` owns one `EnvironmentOperations` receipt set for its process
lifetime, exposed as `execute(taskId, input)`. A canonical request digest detects
ID conflicts. A duplicate shares pending execution or reads a retained result;
socket replacement must reuse this same owner, never create a new receipt set.
Returned values are independent copies. Receipts retain sanitized failures too,
without raw exceptions. Limits are 256 operation IDs, 64 KiB canonical input and
512 KiB serialized result per operation. Capacity exhaustion rejects new IDs;
there is no eviction that could allow re-execution. Oversized results report an
explicit result-size error, not success. These are runner-local bounds, not a
durable Task retention service. Runtime loss loses these receipts; the control
plane must report an unconfirmed result rather than start replacement execution.
The socket adapter forwards operations through this same set and resends
retained results after redelivery. Socket loss itself does not close this process
scope. The internal Environment Object reserves an operation ID and canonical
request against the current runtime, with one pending operation. The validated
caller supplies canonical JSON; the object stores those bounded bytes and compares
them directly on repeated admission, without retaining a derived digest. It commits the
first result before sending its acknowledgement. An identical result can be
acknowledged again; a conflicting result cannot replace the committed result.
Owner, connection generation, close intent and deadline checks protect this
boundary. Acknowledgements do not evict runner receipts.

This storage path requires SQLite-backed Durable Objects. Its 512 KiB result
bound fits the SQLite key/value limit, not the legacy KV-backed value limit.
Local workerd tests cover duplicate results, conflicting results, owner checks,
slot release and a result larger than 128 KiB. Admission commits before outgoing
delivery. A ready connection redelivers the persisted pending request only to
the same runtime incarnation, using the current connection generation. The
delivery gate prevents close or rebind from interleaving between its eligibility
reads and send; a failed send retains the pending record. Sending does not prove
execution or result persistence. Local WebSocket tests exercise replacement
connections and ready-before-redelivery ordering. Close commits its intent before
sending a generation-bound close message to the ready runtime, including when an
operation is pending. Repeated close can redeliver that intent; it does not release
capacity or claim the GitHub run has stopped. The runner closes admission and its
local scope on this message. Internal `closeExecution` also uses the Principal's
current Actions authority to check the bound run's current attempt, request
cancellation and observe the exact attempt once. Only observed completion releases
capacity; failures retain close intent and cleanup responsibility. An unbound run
remains closing until its identity can be established. GitHub's cancel API is
run-scoped, not an atomic attempt-conditional operation: the read-before-cancel
check cannot exclude a concurrent manual rerun between HTTP calls. Public MCP
tools and Task methods reach these internal methods through
`environment-task-authority.ts`; the internal methods are not public endpoints.

`connectRunnerEnvironment` binds a connection to the fixed HTTPS control-plane
origin and Environment ID. Each attempt obtains a fresh GitHub Actions OIDC
assertion through the same dependency-free `runnerIdentity` function used by
Task callbacks. The audience is the control-plane origin; credentials travel
only in headers, identity fetches reject redirects, and failures do not expose
upstream diagnostics. `serveRunnerEnvironment` creates one runtime UUID outside
its connection loop. It reuses the supplied Environment port and receipts across
connections. Reconnection waits one second; each attempt is bounded to ten seconds
and by the original absolute deadline. No Task status polling is involved.
Successful handshakes must preserve the deadline and increase generation; policy
rejection closes the local scope instead of retrying it. Deadline or explicit
close aborts connection attempts and closes local admission. This serving adapter
is composed by the TypeScript `environment-entry.ts` entrypoint.

Bootstrap claim sends the job's repository-scoped GitHub token in a separate
HTTPS request header, after obtaining fresh OIDC. The control plane validates
OIDC before using this token to observe the bound job start; it does not store
the token or forward it through the runtime WebSocket. The claim returns only
stop, or the stored executor and absolute deadline. The internal budget is a
60-minute job with one minute reserved for cleanup; the Environment workflow
must use the same budget and the job name `Environment`. Repeated claims do not
extend the stored deadline. Agent and command children must not inherit this
bootstrap credential. User Actions authority still owns dispatch and cancel.

`run-environment.yml` invokes the entrypoint directly with Node 24. It installs
runtime dependencies, claims before loading provider credentials, uses official
provider installers, and serves the bound Environment. The claim handoff contains
only executor/deadline with file mode 0600; Actions output contains only executor.
The serving worker thread drains dependency diagnostics without forwarding them
to public logs. Provider process configuration is shared with the current Task
driver, and provider credential configuration has one implementation. Signals
request local lifetime closure, including during ACP startup. The job timeout
remains the external containment boundary if cleanup does not complete.

The Worker registers the Environment tools at `/mcp` and authenticates the
runner's `/internal/environments/` routes with GitHub Actions OIDC.
Native ACP form requests wait in the same runtime and resume from an exact
Task/input-ID answer. The channel publishes pending forms; the Environment DO
stores requests and answers, projects `input_required`, and routes standard
`tasks/update` to the runtime. Duplicate answers are idempotent, conflicting
answers are rejected, and cancellation takes priority over undelivered answers.
Grok's native
`ask_user_question` is mapped to the same form channel: answers use question text
as keys and arrays of selected labels; free text uses `annotations.notes`.
This follows the [upstream wire contract](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-tools/src/implementations/grok_build/ask_user_question/types.rs).
Plan-mode chat/skip shortcuts are not exposed; users can answer or cancel.
Codex uses its native default-mode user-input feature through `CODEX_CONFIG`;
provider support must be verified separately from ACP form transport. Neither
provider input nor a reconnect extends the Environment's original hard deadline.

Run `node --test tests/command.test.ts`. `formal/CommandCompletion.tla` checks the
focused safety obligation that return requires observed process exit and stream
closure. The faulty configuration returns on stop intent and must violate that
invariant. It does not prove OS progress, process-tree containment, or refinement
of the complete Environment implementation.
