# Live Story: Autonomous Task result

## User story

As an authorized Harness Principal, I can ask Codex or Grok to perform one
bounded code task and read its semantic final response through the same MCP
client, without publishing private task data in GitHub logs.

Use this story after a merged and deployed change affects Task execution,
authorization or results. This is a development-time live story, not CI automation.

## Real path

MCP client -> run_task -> temporary GitHub run -> selected native Agent ->
authenticated finish -> wait_task -> user-visible final response.

## Acceptance

Given the reviewed revision is deployed, the client has valid tasks:manage
authority, and provider/Agent credentials are configured, when the caller
submits one read-only prompt that asks for the first heading of the execution
repository's README, then wait_task returns completed with the requested
heading in its final response and the exact GitHub run is terminal.

Choose the expected semantic text before submission, for example a fixed marker
followed by the current heading. The spelling of that test marker is not a
product interface. Equivalent private representations can prove the same
semantic result if they are linked to this exact Task and execution.

## Partial success is not completion

- A connected MCP client or a configured Secret name.
- queued/running without a terminal response.
- Provider success with text that does not answer the bounded prompt.
- A successful GitHub job without a result visible through wait_task.
- Another Task's result or a rerun substituted for the original failure.

## Material failure boundaries

The selected executor must perform the work. There is no alternate provider,
automatic resubmission or recovery of final text from workflow logs. Cancellation
cannot undo effects and is not proof of immediate termination. A lost finish
can be reconciled only through the owning user's valid authority and exact
terminal GitHub evidence; there is no unattended observer.

## Proof plan

### Preconditions

- Record the tested source revision and deployed Worker identity privately.
- Run relevant tests, typecheck and workflow lint.
- Reuse an existing valid Task grant. If consent is missing, provide a link and
  pause for the user; do not control their browser.
- Use a read-only prompt without secrets or external writes.
- Confirm any requested live run and its model cost are authorized.

### Proof-run invocation budget

One run_task invocation for the selected executor. Repeated wait_task calls
observe that same Task and do not create another model execution. Do not submit
again to hide a failed or incomplete proof run. Provider-specific changes can
require a separate explicitly scoped run for the other provider.

Cancellation and controlled lost-finish acceptance are separate changed-boundary
checks, not mandatory destructive operations for every documentation deployment.
Private GitHub write checks require the separately approved disposable repository,
exact temporary targets and cleanup; a read-only smoke cannot prove them.

### Secret-safe evidence

Record bounded pass/fail facts for authenticated discovery, final-response
match, exact workflow/revision, terminal run, absence of unintended writes,
and known private markers in public logs/artifacts. Raw response equality alone
does not prove semantic completion.

Keep Task/run IDs only in restricted local evidence when needed to link the
operation and cleanup. Public documentation carries no live identifiers,
private prompts/results, provider URLs, raw protocol data, credentials or full logs.

### End the proof run

Confirm the exact run is terminal. If a run fails or cannot finish within the
approved bound, request cancellation of that exact Task/run when authorized,
then observe its final state. Do not leave paid or temporary work running.
Preserve a failed result as failed; do not classify it as success after a rerun.

## What this does not prove

This proves only the tested artifact, deployment, client, executor and bounded
prompt. It does not prove all business objectives, multi-user isolation, future
provider versions, seven days of real-time retention, arbitrary GitHub write
permissions or a latency guarantee. Local fixtures cover their declared seams,
not those external claims.
