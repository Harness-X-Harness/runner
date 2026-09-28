# Modern MCP integration probe

Development-only probe for [#139](https://github.com/Harness-X-Harness/runner/issues/139).
It does not register production tools, dispatch a runner, call a model, or use
credentials. The independent package keeps experimental SDK versions out of the
production dependency tree.

```sh
cd experiments/mcp-tasks
npm ci --ignore-scripts --no-audit --no-fund
npx tsc --noEmit
npm test
node probe.ts
```

The probe starts an ephemeral loopback HTTP server and closes it before exit.
Requests and subscriptions have five-second bounds. It uses only public SDK
interfaces and validates the synthetic Task handle with the official extension
schema before sending it.
The HTTP boundary uses the official `@modelcontextprotocol/node` adapter;
the probe does not implement Node-to-Web request or response conversion.

The TypeScript probe also retains an explicit expected compiler error where the
SDK tool callback does not accept the extension result type. This is a negative
compatibility check, not a production type escape. If SDK typing gains support,
remove that directive after checking runtime behavior.

Its controlled HTTP client performs:

- an immediate tool call;
- resource discovery, subscription acknowledgement, notification and an
  event-triggered resource read;
- a Task handle response and registration/routing of the three Task methods;
- a subscription request with a Task filter and inspection of the accepted filter.

Exit `1` means a required public integration path was rejected. Exit `2` means
routing was accepted but the full lifecycle remains untested. Unexpected errors
also exit nonzero; inspect the report and error rather than treating every
failure as an SDK defect. This probe cannot report full #139 acceptance.

The synthetic Task is not executed or persisted. Method registration does not
prove input handling, cancellation or durability. Those checks, owner/scope
boundaries, reconnect recovery, and real host delivery remain separate work.
The loopback client is not ChatGPT or Codex, and the probe does not prove their
UI or model-resumption behavior. It does not use polling or a legacy fallback.

The separate native transport tests check the public low-level SDK seam:
subscription acknowledgement is a notification, Task notifications can follow,
and only the final JSON-RPC result ends the stream. Request abort also closes the
stream. These in-memory Response tests do not implement the protocol dispatcher,
Task storage, filter authorization, or durable event delivery. Their success does
not replace the full HTTP probe or count as #139 acceptance.

`apps/chatgpt-app/src/task-methods.ts` is the shared binding for `tools/call`, the three Task
methods and `subscriptions/listen`. It
composes the public request classifier, extension schemas and per-request
transport without the high-level server's method registry. Native HTTP tests
check successful routing, capability and header rejection before handlers,
Unicode `Mcp-Name`, response validation, and safe errors. A synthetic identity
fixture rejects a second Principal before dispatch; this is not OAuth, per-Task
ownership, or scope verification. Separate subscription HTTP tests inject one
shared authority for reads and notifications, filter two synthetic Principals,
and recover a completed result on reconnect without polling. The caller must
authenticate and bind this authority to the Principal and grant. The binding
does not own Task state or join the production endpoint. Its supplied authority
owns Task creation and execution. Complete
#139 acceptance still requires durable lifecycle and real authorization evidence.

`lifecycle.test.ts` supplies a temporary SQLite authority through real loopback
HTTP. It checks capability rejection before insertion, immediate handle read,
database close/reopen, input response routing, and cancellation acknowledgement
separate from terminal status. Business error results remain completed Tasks;
JSON-RPC execution failures are failed Tasks. The database and its directory are
removed after the test. These controlled transitions are fixtures, not an Agent
execution, a production Task store, Cloudflare crash recovery, or real OAuth.
The same SQLite fixture also publishes notifications from committed writes:
one Task goes through creation, input, update, completion, disconnect, database
reopen and resubscription. A separate trace observes confirmed cancellation.
Another trace uses the official `StreamableHTTPClientTransport` against that
same HTTP endpoint: three traces receive completion, respond to input, and cancel.
Each asserts the exact outgoing method list: creation and subscription, plus
`tasks/update` or `tasks/cancel` where needed, never `tasks/get`. Input response
and completion notification may arrive in either order on separate requests.
Cancellation acknowledgement is checked separately from confirmed cancellation.
It does not use the high-level Tasks execution driver.
This proves the transport seam, not a desktop client's discovery, consent, UI,
OAuth consent UI or automatic model continuation.
The SQLite fixture also revokes a synthetic grant before subsequent operations
and authority reads. New calls and subscriptions are denied without storage
changes; an existing subscription receives a safe error and closes instead of
delivering the next committed result. Observers are detached. This does not test
real OAuth revocation, distributed grant propagation, or recall of data already
authorized and sent before revocation.
The experiment currently requires Tasks capability for every tool call; a
production mixed catalog must keep ordinary non-Task tools on their own declared
capability contract rather than inheriting this experiment's restriction.

`node client-probe.ts` inspects the official Tasks requester's default behavior
with a synthetic port and no notifications. It reports the dispatched methods
and exits `2` because this is not real-client or event-only acceptance. It does
not connect to production, call a model, or change the library's observation
policy. Client discovery, authentication and subscription integration are not
covered by this diagnostic. SDK configuration limitations belong in observed
evidence, not an assumption that a future version will behave the same way.

The HTTP probe and subscription tests share `eventsource-parser` for SSE parsing;
there is no handwritten frame-parser fallback. Test streams close after their
bounded checks, and server-side observers are checked for detachment.

`apps/chatgpt-app/src/task-observation.ts` observes an injected authority without storing a second
Task state. It registers before reading, serializes reads, and coalesces change
signals received during a pending read. Each new subscription reads the current
snapshot, including a result completed while disconnected. The source must
register synchronously with the read authority, signal committed changes, check
authorization on every read, and honor abort. This local interface does not
prove a remote event source supplies those guarantees.

`formal/TaskObservation.tla` is a focused safety model: one Task, one observer,
and two revisions. It separates subscription, read start, concurrent commit,
and read completion. `NoLostWake` requires another read to remain enabled when
the delivered snapshot is stale. The faulty configuration clears the change
flag at completion and exposes the same order forced by the native test.
There are no fairness assumptions, symmetry reductions, or state constraints;
deadlock checking is disabled because an up-to-date idle observer is quiescent.
Disconnect, authorization, persistence and cross-process signals are outside
this model. It is not a whole-system refinement or a liveness guarantee.

Versions are owned by package.json and package-lock.json. Record observed
compatibility in issue evidence or local project memory, not as a permanent
assertion that one SDK version must remain broken. Do not patch SDK internals
to make this probe pass.

`resources.test.ts` uses the official handler with two synthetic Principals.
Each sees only its own resource and cannot read or subscribe to the other's URI.
Subscription permission is checked before SDK routing: URI filters are not ACLs.
An authorized URI notification triggers a read of current content. Removing the
fixture grant denies subsequent list/read/listen requests. Its `AbortSignal` is
combined with the request signal: revocation closes an already-open stream before
a later URI update, while another Principal's reads still work. This verifies the
local SDK cancellation seam, not distributed OAuth revocation propagation or
recall of previously buffered data. Per-Principal handlers here are bounded
test fixtures, not a production handler registry or storage design.

Current evidence scopes (not interchangeable):

| Client boundary | Evidence | Not proved |
| --- | --- | --- |
| Controlled HTTP fixture | Task lifecycle, reconnect, owner/grant checks | Real OAuth and Agent execution |
| Official client transport | Handle, input/update, cancellation and completion events without `tasks/get` | Full client discovery and OAuth consent |
| Official Resource handler fixture | Owner-scoped list/read/listen, event-triggered read, grant-signal stream teardown | Real OAuth revocation propagation |
| ChatGPT / Codex host | Unverified for this new protocol path | Notification delivery and model continuation |

Protocol authorities:

- [Tasks specification](https://github.com/modelcontextprotocol/ext-tasks/blob/6c0997fbc040e6145c5cbd1e757aef9debb94303/specification/2026-07-28/tasks.md)
- [Official Tasks schemas and adapters](https://modelcontextprotocol.github.io/ext-tasks/typescript/adapters-and-schemas.html)
