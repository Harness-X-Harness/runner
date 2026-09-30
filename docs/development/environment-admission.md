# Environment admission obligation

An admitted Environment retains its capacity reservation while opening, live,
closing, or awaiting reliable stop evidence. A cancellation acknowledgement,
elapsed startup deadline, or failed observation does not prove that its runtime
has stopped. A delayed dispatch can still create a runtime after close intent.

`formal/EnvironmentAdmission.tla` isolates this obligation. Reservation is an
atomic authority action; external start, close intent, and exact-runtime stop
confirmation are separate actions. A stop confirmation prevents a subsequent
start for that same runtime identity. Dispatch/observation may never complete:
there is no fairness or liveness claim.

The finite model has two owners and three Environment identities, including two
competing identities for one owner. Its capacity is two, not the production
policy of four. It checks retention of responsibility and owner exclusion;
it is not a parameterized proof of arbitrary global limits. The faulty variant
releases on close intent and permits a second runtime for the same owner before
the first stops. No state constraints or symmetry hide that trace; deadlock
checking is disabled because pending external work may remain quiescent.

This is a requirements obligation, not an implementation-refinement claim.
Storage transactions, crash recovery, idempotency receipts, dispatch rejection
before any effect, multiple GitHub attempts, OAuth, deadlines, and actual stop
observation require separate implementation evidence. No production admission
service is registered by adding this model.

## Internal storage seam

`environment-service.ts` composes authenticated open/close with the Environment
Object. It requires `environments:use` consent. The service uses Principal and
expiring scoped Actions-token validation. Open validates authorization before
storage or GitHub effects. A supplied idempotency key derives an owner-scoped
128-bit Environment ID; the immutable creation record rejects executor conflicts.
Without a key, each call receives a random ID. This internal service does not
replace MCP Tasks capability checks or provide the public Task result contract.
Close records intent before requiring a usable external Actions credential.

The internal MCP authority projects open and close as standard Tasks. Each has
one bounded receipt in its Environment, outside the command/agent execution slot.
Open completes on the first accepted ready frame; later disconnection or closure
cannot undo that result. Close completes only when capacity release is confirmed.
Cancelling a pending open requests cleanup and remains working until release;
cancelling close cannot retract cleanup. A completed open is not a close command.
Receipts share Environment result retention and existing event-driven observers.
They store operation completion history, not a second runtime lifecycle.

`apps/chatgpt-app/src/environment-admission.ts` implements transactional
reservation with the configured initial policy: one held reservation per owner,
four globally. Its owner-filtered list contains only held memberships, not Task
history or runtime state. Repeated reservation is idempotent for the same owner
and identity; a released identity cannot be reserved again.

Owner and global capacity are typed admission results, not exceptions. Owner
capacity includes the held owner's Environment ID and is non-retryable; global
capacity is temporarily retryable. The service reads the existing Environment's
status through its owner check. An absent snapshot omits status; storage faults
remain internal errors. Both MCP client types receive the same complete tool
error and machine-readable facts. Rejection does not create an open lifecycle
receipt, consume capacity, dispatch, reconcile or queue. The immutable creation
record remains for idempotency; its admission deadline does not restart.

The internal Environment MCP handler uses this same membership for
`resources/list`; there is no second owner directory. It reads each member's
owner-checked Environment snapshot and excludes closed environments. The current
capacity bound fits in one page; no cursor is issued and supplied cursors are
rejected. Listing is a membership read followed by lifecycle reads, not a
cross-object atomic snapshot. Read failures fail the request rather than produce
an incomplete successful catalog. A concurrent close can remove an item, and a
concurrent open can appear on the next read.

`harness://environments/{environmentId}` reads current state without dispatching
or performing cleanup. It requires `environments:use` and derives the owner from
the current authorization, not the URI. Readiness requires a live socket for the
current ready generation and an unexpired runtime deadline. A disconnected or
expired runtime is `unavailable`, not closed; close intent is `closing` until
capacity-release acknowledgement. Before the job establishes its hard deadline,
`expiresAt` is null. Snapshots contain no runtime identity, connection generation,
GitHub token or private prompt. Known closed resources remain readable from their
own authority; they are not a historical listing. Environment resources support
the same standard subscription path as output resources. Committed readiness,
runtime replacement connections, active-operation changes, close intent and
capacity-release acknowledgement wake readers. Socket close/error also wakes
readers, but is not stop evidence. Notifications contain only the resource URI;
each delivery rechecks current owner/scope before the client reads the current
snapshot. Internal streams share cancellation/framing code and do not persist a
second lifecycle copy.

The first cancellation intent updates the operation timestamp and wakes Task
observers. Pending input is no longer offered once cancellation is requested;
the Task remains working until a native result or confirmed execution end.
Duplicate cancellation can redeliver the intent but does not change timestamps.

Task lookup represents missing, expired and other-owner records identically as
an absent value across the internal RPC boundary. `tasks/get` maps this to the
standard invalid-params error (`-32602`), without copying private exception text.
Storage faults remain internal errors (`-32603`), not successful empty reads.

The new MCP entry checks the current OAuth token before starting a protocol
response. SDK-generated Bearer challenges report `401 invalid_token` for missing,
expired or wrong-audience tokens, and `403 insufficient_scope` for grants without
`environments:use`. Challenges identify the canonical protected-resource metadata
URL. Authorization storage failures return a sanitized 500 instead of requesting
new consent. This preflight does not cache authority: operations and subscription
delivery continue to recheck the grant. OAuth metadata lists both scopes only
during this acceptance boundary; existing grants are not upgraded.

The new handler implements standard `server/discover` and `ping`. Discovery
advertises protocol 2026-07-28, tools, resource subscriptions and the Tasks
extension; it does not advertise directory-change notifications or prompts.
Discovery and ping do not require the client Tasks capability and cannot start
execution. Ordinary `tools/call` also does not require Tasks, but it can start
execution and returns an acceptance receipt. Task methods and Task subscriptions
still require the declared capability. The entry's OAuth gate applies before
protocol handling.

Output resource capture and reads are described in
[command runtime](command-runtime.md). A native Durable Object alarm schedules
the current startup/runtime deadline. Before the first ready generation it uses
the earlier of the immutable startup limit and any established hard deadline;
after ready it uses the earlier of that hard deadline and the idle deadline.
Idle means no active operation: first ready and each first accepted result start
a fifteen-minute idle period. Admission of a new operation clears that period;
duplicate ready/results, reads and reconnection do not renew it. Waiting for
Task input is active work and remains bounded by the unchanged hard deadline.
New work is rejected after idle expiry even if the alarm has not fired.
First readiness and first runtime binding also reject an expired startup limit
even when the alarm is delayed. An early/stale alarm reads current facts and
reschedules; a due alarm commits close intent, wakes observers and attempts
delivery to the current runtime. Duplicate alarms cannot reopen an Environment
or infer execution stop. Confirmed release replaces the runtime alarm with the
result-retention alarm.

The alarm has no stored user GitHub token and does not claim it cancelled a
queued/disconnected run. Exact-run observation and the backend's hard job budget
remain necessary. Selecting this handler requires fresh Environment consent;
the endpoint does not infer it from a protocol version or an old Task grant.

`releaseConfirmed` is an internal authority call, not evidence verification or a
public endpoint. The Environment lifecycle must verify exact stop evidence or
prove dispatch was not issued before calling it. Closing intent alone is not proof.

The admission module is bound internally in the Worker and reached only through
the authorized Environment handler. Each reservation carries an
`admitUntil` deadline from the immutable Environment creation record. The caller
must reuse that deadline on every retry and must not accept it from an MCP client.
Expired admission requests are rejected. Released receipts can be removed during
a later successful admission only after that deadline; held reservations are
never removed by expiry. The stored collection is capped at 256 receipts and
refuses admission when full rather than evicting replay protection. This is a
storage bound, separate from the four-runtime policy.

`environment-creation.ts` stores one immutable identity, owner, executor and
creation/admission times per Environment. Repeated creation returns the original
record even if time or startup policy changed; conflicting parameters fail.
Caller-supplied timestamps are rejected. Admission retries must use this record.
After capacity release, operation requests, inputs, results and output are retained
for seven days. One Environment deadline governs all retained content; Task TTL
is derived as that deadline minus Task creation time. Before close, no retention
deadline is advertised. Reads and duplicate operation calls reject expired content
even if the native cleanup alarm is delayed. The alarm deletes operation/output
keys in bounded batches and wakes existing observers. Repeated close does not
extend retention. Minimal creation, execution and closed-state records remain to
reject resurrection of the same identity; they contain no prompts or output.

`environment-object.ts` binds the supplied Environment ID to the actual Durable
Object ID before creation. Its internal `initialize` RPC commits creation before
calling the singleton admission object with that record. Concurrent retries
reuse the committed record. Local workerd tests exercise this cross-object path.
The Worker exports `BoundedEnvironmentObject` and `EnvironmentAdmissionObject`;
Wrangler binds them as `ENVIRONMENTS` and `ENVIRONMENT_ADMISSION`. The bounded
Environment uses its own deployment class identity. The admission RPC trusts its
internal caller; the public tool must derive
the Principal from authentication and call Environment initialization, never
forward caller-supplied admission records.

After admission succeeds, the Environment stores that fact locally.
`beginDispatch(ownerId)` consumes a durable one-time dispatch permission in a
transaction. Only the first eligible call returns `send`; others return
`already-issued`. Missing admission, another owner, or an expired unissued
request cannot consume permission. The external HTTP dispatch must happen
after this commit and only for `send`.

This decision is not proof that GitHub received a request. A crash after commit
but before send, or loss of a response, leaves an uncertain dispatch and must not
cause automatic replay. `dispatchExecution` sends only after this permission is
committed, using the current Principal's supplied Actions token. A definite HTTP
rejection with no verified execution claim persists rejection and close intent
before releasing unused capacity. A concurrent claim prevents this release;
unknown delivery retains the reservation. A failed release can be resumed by
close from the persisted rejection. Startup expiry records close intent; it does
not supply missing dispatch or stop evidence.

The current GitHub dispatch API returns `workflow_run_id`. The Environment saves
that authoritative allocation identity without requiring an OIDC claim first.
It can therefore observe and cancel the first attempt while queued or after an
early failure. OIDC admission must match the returned run and first attempt; the
dispatch response alone does not make a runtime ready. A close or startup expiry
that wins before the response is handled invokes exact-run cleanup once the ID
arrives. Missing or malformed success details remain unknown, never a reason to
dispatch again. A lost response without a later claim still lacks a run identity;
this path does not introduce list scanning or a replacement dispatch.

`requestClose` persists owner-checked, idempotent close intent. The dispatch
transaction checks this intent before issuing permission. If close commits
first, no new permission is issued; if permission committed first, remote work
may still start and remains subject to cleanup. Repeated initialization cannot
clear close intent. Close intent alone never releases capacity or proves stop;
persisted definite dispatch rejection can release an unused reservation.
Close during admission waits for its acknowledgement. Admission completion
checks the persisted close intent and releases the reservation without dispatch.

`bindExecution` accepts only one repository/run/attempt tuple for the owner after
dispatch permission was issued. The internal caller must verify fresh workflow
OIDC before invoking it. Another run or attempt cannot replace the binding.
A first claim arriving after startup expiry or close is retained for cleanup
and receives `stop`; it does not reopen the Environment. `bound` confirms identity
only, not readiness, a WebSocket generation, or permission to execute commands.
`environment-callback.ts` verifies the shared GitHub OIDC contract for
`run-environment.yml` before calling this method. Owner and execution fields come
only from signed claims; request bodies cannot override them. The Worker mounts
this handler under `/internal/environments/`. Claim establishes the hard runtime
deadline using the job's temporary GitHub observation token. The Environment
tools dispatch `run-environment.yml`; see [runner composition](command-runtime.md).

`observeJobStart` reads the job's `started_at` from the bound workflow run
attempt's jobs endpoint. It requires exactly one matching job name and a complete
response; missing timestamps, ambiguous names and lookup failures are errors.
There is no fallback to callback, readiness or connection time. This internal
observer requires an execution already bound through verified OIDC.
`establishRuntimeDeadline` uses it to persist `job start + job budget - cleanup
margin` once. Repeated calls return the stored deadline, even after a policy
change; elapsed installation time is not restored. The GitHub observation is
outside the storage transaction, and the commit rechecks close intent. An
already elapsed deadline remains elapsed, not a new lifetime. This internal
method does not declare readiness or release capacity. The workflow's job budget
and cleanup margin determine the deadline passed to runner lifetime and command
admission; readiness does not restart that budget.
The local workerd test holds the job lookup pending, commits close, then releases
the lookup and requires deadline establishment to fail. Promise barriers define
the ordering without timing sleeps. This checks that delayed evidence cannot
override close intent; it is not production network or crash-recovery evidence.
The [GitHub workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)
is the timestamp authority; local fixture tests are not live API acceptance.

`bindRuntime` is an internal transport-admission transaction. It requires the
bound execution, an established unexpired deadline and no close intent. The first
runtime UUID is retained permanently for this Environment. Later connections may
advance a monotonic generation only for that same UUID; they cannot replace the
runtime or refresh its deadline. Local workerd tests check concurrent generation
allocation, replacement rejection and close rejection. Each future upgrade must
verify fresh OIDC before invoking this method. The internal connect route now
verifies OIDC before reconstructing the trusted upgrade request; user-supplied
execution headers and bearer credentials are not forwarded. The DO uses native
hibernatable WebSockets with runtime/generation attachments. Its ready-message
transaction checks the canonical generation, deadline and close intent before
recording readiness. Old or invalid messages close only their own socket with
1008. Disconnect does not imply stopped execution or release capacity. Local
workerd tests open two real sockets and reject the older connection's ready
message. The Worker routes the authenticated upgrade to this object. Advancing
a generation does not prove readiness or delivery of any operation.

Current-generation socket close/error and local message rejection store one
bounded reconnect diagnostic: category and server observation time. It is
owner-private and contains no socket reason, exception, token or URL. Generic
closure does not overwrite a known rejection/error for the same generation.
Late events from older generations cannot update it. A new connection alone
does not clear the observation; accepted ready clears it without renewing idle
or hard deadlines. Confirmed closure removes it. Diagnostics never supply
lifecycle or capacity-release authority, and failure to store an observation
cannot change the existing transport decision. Unauthenticated identity or
unobserved handshake failures cannot be inferred from disconnection.

The runner's `connectEnvironment` uses the `ws` package for framing and upgrade.
It requests a token for each explicit connection attempt, sends credentials only
in headers, disables redirects and validates the connected generation/deadline.
Only WSS is accepted except loopback WS for local development. An abort signal
bounds the handshake; transport closure is reported independently from runtime
termination. It does not retry or execute messages. A real loopback WebSocket
test covers fresh headers across connections, expired handshakes and closure;
it does not prove deployed OIDC-to-DO integration. `serveRunnerEnvironment`
retains one runtime identity and supplies the same Environment and original
deadline across reconnections.

`serveEnvironmentConnection` attaches one socket to an existing Environment port.
After ready acknowledgement, execute messages must match both the connection's
generation and the runtime owner's current generation. Results are sent only on
that still-current open connection. Malformed messages close the socket; they
do not start work. Pending deliveries and buffered output have explicit bounds.
Disconnection removes socket listeners but leaves execution and receipts with
the Environment. Controlled loopback tests redeliver the same ID on a new
generation both before completion and after completion during disconnection.
Both check one real filesystem effect and a result on the new generation.
The control-plane result
store acknowledges only after its transaction commits; duplicate results preserve
that record and conflicting results are rejected. See [operation delivery](command-runtime.md)
for the current bounds and integration limits. Socket send is not proof of durable receipt.

`confirmExecutionStopped` checks the exact stored execution tuple, persists stop
confirmation and close intent, then releases the reservation through the
admission object. It returns `closed` only after release succeeds. A trusted
stop also ends any pending operation in the same local transaction, with an
unknown-outcome failure rather than fabricated success or cancellation. Existing
terminal results and retained output stay unchanged. Task observers are notified
after commit; duplicate stop confirmation preserves terminal timestamps. External
effects may have occurred, so this failure does not authorize an automatic retry.
A trusted
GitHub observer must invoke it; the runner claim route cannot call it. Duplicate
confirmation reuses the same binding. Local workerd checks that a mismatched
attempt cannot release capacity and that a later claim cannot reopen a stopped
Environment. `observeStop` reads the stored binding and performs one bounded
GitHub lookup using the Principal's supplied Actions authority. It confirms stop
only for a matching completed workflow attempt. Unbound and nonterminal runs
remain unconfirmed; errors propagate without release. The existing Task and new
Environment paths share this exact-run observation implementation, with an
explicit workflow argument. No scanning or polling loop is added.

The internal `environment-webhook.ts` receiver verifies the original payload
with Octokit's `@octokit/webhooks-methods` and a configured `GITHUB_WEBHOOK_SECRET`.
For Environment termination, only a signed `workflow_run.completed` for the
configured execution repository and Environment workflow is eligible.
Its opaque run title routes to the DO;
the stored owner/run/attempt binding, not the title, authorizes closure. The
same exact-run parser handles REST observations and signed GitHub events.
The receiver acknowledges only after durable stop handling succeeds. Invalid
signatures cannot touch storage; unmatched execution or storage failure does
not produce a successful acknowledgement. Duplicate matching events reuse the
existing terminal state. It does not register a new execution from an event.

The Worker mounts this receiver at `/github/events`. Deployment requires the
same webhook secret in the Worker and the GitHub webhook configuration, with
`workflow_run` delivery enabled. CI events require the separate explicit
`GITHUB_CI_EVENT_REPOSITORIES` JSON array. The receiver routes covered completions
to the admission object's held Environment IDs (bounded by global capacity),
without another global index. Each Environment accepts only an existing wait
for its active, uncancelled Agent Task and exact repository/run/attempt/revision.
The first completion is immutable. Events never register waits or start turns.
Wait receipts are capped at 256 per Environment and share result retention.
The runner tool verifies access with its work credential before exposing any
event result. Registration and observations use the authenticated runtime socket;
results replay from durable receipts on the current generation. Runtime promises
survive connection replacement and resolve only from durable acknowledgement.
Cancellation aborts the original tool wait before stopping the Agent turn.
The private MCP tool is supplied through ACP's native session configuration.
Receiving a webhook alone does not prove Agent progress; provider acceptance
must include delivery to the native tool and continuation of the same turn.
Missing delivery
or delivery before the binding is available still needs bounded authenticated
reconciliation or operator redelivery; GitHub does not guarantee automatic
redelivery. No platform GitHub token is added to this event path.

Before dispatch permission is consumed, close can release an acknowledged
reservation: the local transaction records close intent and proves that no
dispatch was issued. A concurrent admission completion checks that intent and
releases its reservation instead of starting work. An in-flight admission with
no acknowledgement remains `closing` until that evidence arrives. Startup alarms
use the same close path. Once dispatch was issued, an uncertain response still
requires exact-run stop evidence; elapsed time alone does not release capacity.

Public authorization, GitHub observation and process recovery are separate
evidence boundaries. Local workerd fault injection covers
failure before release and a lost reply after release: neither reports closed
prematurely, and explicit observation resumes cleanup from persisted evidence
without external HTTP. These tests do not simulate process crash or eviction.

Stop confirmation and capacity-release acknowledgement are separate persisted
facts. Once release is acknowledged, repeated close returns `closed`, not
`closing`. Once stop is confirmed, observation can retry release from that fact
without another GitHub request. Release remains idempotent after its expired
receipt is collected; it does not alter another Environment's reservation.

The admission storage seam alone cannot detect a caller forging a new deadline
after receipt cleanup.
Only the internal lifecycle adapter supplies the immutable creation record for
release. Local storage tests do not establish process-restart behavior. There is
no periodic cleanup or hidden admission queue.

`tests/environment-admission-sqlite.test.ts` executes the module on local workerd
SQLite. Five competing owners receive exactly four admissions; a duplicate does
not consume another slot, wrong-owner release fails, and a released identity
cannot return. The service is reconstructed per request. This proves the local
storage seam, not a deployed endpoint, process restart, or GitHub stop evidence.
