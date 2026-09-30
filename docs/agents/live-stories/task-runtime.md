# Live Story: Work in one bounded Environment

## User story

As an authorized Harness Principal using a modern Tasks-capable MCP client, I
can run a command and continue a coding-agent conversation in one temporary
workspace, observe their results, and close that Environment.

The ordinary-client receipt contract is in [the MCP contract](../../chatgpt-app.md).
When that adapter changes, use the same bounded runtime with no Tasks declaration
on its tool calls: inspect an exact pending question, answer via `update_operation`,
and verify that same operation finishes. Separately cancel one operation and
verify a subsequent command works without recreating the Environment. A capable
observer may supply event-driven test evidence; that does not prove ordinary host
subscriptions or automatic model continuation. Never turn inspect into polling.

This is development-time acceptance, not CI automation. Use existing scoped
evidence for unchanged boundaries; do not repeat a full provider matrix for
every deployment.

## Real path

MCP OAuth -> open_environment -> temporary GitHub execution -> ready ->
command / agent -> standard Task and Resource observations -> close_environment.

## Acceptance

Given the reviewed revision is deployed, the client has valid
`environments:use` consent and modern Tasks/subscription support, and the selected
executor is configured, when the caller opens one Environment, runs a harmless
workspace command and two related Agent turns, then the second turn can use the
first turn's context in the same workspace, both operations return their semantic
results to that client, and close reaches completed with the exact run terminal.

Resource output and semantic final results are separate: commentary must not
be mistaken for the final answer. Observe changes by subscription, not repeated
Task polling. Resource URI notifications trigger reads of bounded snapshots.

## Partial success is not completion

- OAuth or tool discovery without actual Task handling.
- A queued/working Task without its client-visible outcome.
- A GitHub success without the requested semantic result.
- Close accepted or closing without confirmed execution stop.
- SDK protocol success presented as a desktop UI or model-continuation result.

## Proof plan

### Preconditions

- Record source, deployment, SDK/client and executor versions privately.
- Run tests, typechecks and workflow lint relevant to the changed boundary.
- Reuse existing client grants and local private credential caches. Use normal
  refresh; require new consent only for missing authority or failed recovery.
- Verify the client's actual capabilities; do not forge unsupported host flags.
- Fix the expected semantic outcome and invocation budget before starting.

### Invocation budget

For the core path: one Environment, one harmless command, two Agent turns and
one close. Choose a read-only prompt or one disposable workspace file; no remote
repository writes. A failed or missing outcome remains failed, not replaced by
a new submission. Reuse the exact handle to observe or clean up uncertain work.

Input, cancellation, multi-client access and CI wait are separate changed-boundary
checks. For input, answer one native question through `tasks/update` and observe
that same Task finish. For cancellation, verify the original turn terminates
before issuing one follow-up turn. For CI wait, use one approved exact run and
prove the original Agent turn consumes its completion without resubmission.
Do not add these model invocations when their boundaries are unchanged.

### Evidence and cleanup

Record bounded facts for semantic results, same Environment/workspace, observed
notifications, terminal operation and exact-run cleanup. Confirm no unintended
remote writes, extra Environment or substituted provider. Check public execution
logs/artifacts for the approved non-sensitive markers and prohibited private data.

Keep IDs, private prompts/results and raw protocol evidence out of public docs.
Never retain credentials or provider URLs in evidence. After a bounded failure,
close the exact Environment and verify its run is terminal; do not leave paid
work running. Data already changed by an Agent is not rolled back by cancellation.

## Events changed-boundary acceptance

Use one Environment, no Agent turns, at most two harmless commands and one close.
Reuse existing OAuth grants. A controlled public HTTPS receiver must verify
Standard Webhooks signatures before acknowledging the fresh challenge, and
store only bounded ID/state evidence privately. It must not accept arbitrary
destinations or publish callback secrets. Arm the receiver before opening.

Confirm `server/discover` advertises Events and `events/list` describes the
webhook-only event. Subscribe without Tasks capability to one owned Environment.
Verify challenge, deterministic refresh ID, initial state, readiness and command
completion with the exact operation ID. Try one non-owner subscription and
confirm rejection before callback verification. Unsubscribe, then run the second
harmless command and confirm its operation event is not delivered. Subscribe
again, close the exact Environment, receive its closed event, and confirm the
GitHub run is terminal. Remove only the temporary receiver and subscription.

Controlled implementation tests cover delayed verification, expiry, revoked
grant, key rotation and late replies. A receiver `2xx` is transport acceptance.
ChatGPT acceptance is separate: rescan the plugin, ask it to monitor the event
and state how to respond, then verify the actual subscribed conversation resumes
without polling. Stop monitoring and confirm delivery stops. Do not claim this
from an SDK test or a receiver acknowledgment.

## What this does not prove

This proves only the tested revision, client, executor and bounded path. It does
not prove all desktop hosts, automatic model continuation, all concurrency
histories, arbitrary GitHub write rights, or seven days of real-time retention.
Controlled tests and formal models cover their named internal boundaries only.
