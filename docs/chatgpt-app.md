# Harness X Harness MCP app

Harness runs commands and interactive Codex or Grok turns in bounded Environments.
The stable MCP endpoint is `https://runners.trustedtunnel.app/mcp`. Cloudflare
owns authentication and Task state; GitHub owns the execution lifetime.

## User flow

Authorize `environments:use`. GitHub verifies the user through the dedicated
GitHub App. Harness derives a user token limited to `Harness-X-Harness/runner`
and `Actions: write`.

### Tasks client

1. Connect a client that declares MCP Tasks on protocol 2026-07-28.
2. Call `open_environment` with `executor`. Subscribe to the returned Task and
   wait for ready. Save its Environment resource link, or discover live owned
   Environments with `resources/list` from another client of the same Principal.
3. Call `command` with literal argv and a timeout, or `agent` with a prompt.
   Optional `model` and `reasoningEffort` on `agent` must match that executor's
   current report. Omit both for the deployment default. The first call fixes
   the pair for the native session. A rejected candidate does not change that
   session, so a later call can correct it. If application of an accepted pair
   fails, or a native configuration request fails after it starts, later
   `agent` calls fail until a new Environment is opened. A model alone uses
   that model's reported effort. An effort alone uses the deployment default
   model, including after the pair is fixed; a different resulting pair is
   rejected. The completed agent result reports the model and effort returned
   by the executor, not an unconfirmed request. `inspect_environment` returns
   that operation's pair and the runner's last reported configuration separately.
   `command` and `close_environment` still work.
   There is no automatic rollback or retry. Agent turns share the workspace and
   native session. Use standard Task
   subscriptions for state and result, `tasks/update` for requested input, and
   `tasks/cancel` for cooperative cancellation.
4. Call `close_environment` and observe completion. A closing status is not
   confirmation of stopped execution or released capacity.

A Tasks client keeps this contract. A missing or failed Task result is not
replaced with an ordinary receipt.

Capacity rejection is a tool-level product result for both client types:
`resultType: "complete"`, `isError: true`, and `structuredContent.outcome:
"capacity_rejected"`. It creates no lifecycle Task and dispatches no workflow.
`capacityKind: "owner"` has `retryable: false` and reports the existing owned
Environment ID in `existingEnvironment.environmentId`, with `status` when
readable. Explicitly continue with or close that Environment first.
`capacityKind: "global"` has `retryable: true` because global capacity can become
available. Neither case automatically closes, reconciles, reuses, queues or
retries work. Do not poll. The policy is one held Environment per Principal and
four globally. A repeated idempotency key retains its original admission deadline.

### Ordinary client

A client using protocol 2026-07-28 that does not declare Tasks calls the same tools. The result is an
ordinary acceptance receipt and the current status. It is not a Task handle and
not proof that the work finished.

1. `open_environment` returns the Environment ID and current status, such as
   `opening`.
2. `command` returns a finished command result when one is already committed.
   Otherwise it returns an operation ID and status `working`.
3. `agent` returns an operation ID and status `working`.
4. `inspect_environment` reads one Environment. It reports status, hard and idle
   deadlines, the active operation and its pending questions (including their
   schema and exact operation ID), and one selected operation when `operationId`
   is supplied. The selected operation does not hide the active operation.
   Its bounded output is a snapshot, not a token stream; replace previous output
   rather than append it. Final response and progress remain distinct.
5. `update_operation` accepts `operationId` and `action: "answer" | "cancel"`.
   For answers, `inputResponses` maps question IDs to `{action: "accept", content}`,
   `{action: "decline"}`, or `{action: "cancel"}`. Content must match the reported
   `requestedSchema`. First accepted answers win; repeated or late replies never
   reopen completed work. To stop the entire operation use `action: "cancel"`
   without `inputResponses`. The current status is returned after the request;
   cancellation is not confirmed until the operation is terminal. This tool uses
   the same owner checks, input records and cancellation as standard Tasks.
6. `close_environment` can return `closing`. Inspect when a person asks. Only
   status `closed` confirms cleanup.

A successful `inspect_environment` or `update_operation` returns a normal tool
result even when the selected operation is cancelled, failed, or has a nonzero
command exit code. Its status and outcome remain unchanged. Invalid requests,
missing ownership and failed reads remain errors.

Call `inspect_environment` when a person asks for the current state. Do not
poll. Without MCP Events support, this contract has no automatic notification or model continuation.
Waiting for input is visible and answerable, but it is not success.

Use `list_environments` with `{}` to find live owned Environments without
creating work. It includes opening, ready, unavailable and closing state, and
omits closed Environments. A failed snapshot read is reported as a failure,
not an empty list. Known retained resources remain readable after closure.
Listing and inspecting do not renew either deadline.

### Chat workbench

MCP Apps clients can intentionally launch the AgentEnv workbench through
`show_workbench`, `list_environments` or `open_environment`, on explicit user
intent. Show resumes/displays the existing workspace here; list browses owned
workspaces; open allocates one only when the user explicitly asks to create.
All eight tools remain visible to both model and app, with the same
`environments:use` authentication and Tasks/ordinary result contracts.

| Tool | ChatGPT-initiated call: Workbench URI | Inside an existing card |
| --- | --- | --- |
| `show_workbench` | Yes: explicit display/resume HERE launcher | Replace this card with the current owned snapshot or chooser |
| `list_environments` | Yes: explicit browse/list launcher | Replace this card with the owned list |
| `open_environment` | Yes: explicit create/open launcher | Replace this card with the opening snapshot |
| `inspect_environment` | No | Refresh/select one snapshot or a specific retained operation |
| `agent` | No | Send through the Agent composer; retain this card |
| `command` | No | Run through the literal-argv composer; retain this card |
| `update_operation` | No | Answer/stop the exact active operation |
| `close_environment` | No | Confirm closure; retain this card and available result |

For a long conversation, say **在这里显示 AgentEnv 工作区**, **回到当前 Codex 工作区**,
or **show current workbench here**. Call `show_workbench` with `{}` at that turn.
Exactly one owned live Environment opens directly with the latest normalized
ordinary snapshot, including the current active operation/questions and trusted
result/output when present, without a list click. Zero live Environments shows
executor choices and starts nothing. Multiple entries show an owner-scoped
chooser (defensive fallback; current production capacity is one per Principal).
Directory, ownership and snapshot failures remain errors. Opening, ready,
unavailable and closing are supported; closure during the read can yield a
retained closed snapshot or an error, never a fabricated empty view.

**列出我的工作区 / browse my workspaces** calls `list_environments`;
**创建一个新的 Codex 工作区 / create a new Codex workspace** calls `open_environment`
only on that explicit creation intent. **当前工作区是什么状态？ / what is the workspace
status?** calls `inspect_environment` for facts and a chat answer without a card.
Show does not create/reopen an Environment, runner, Agent session, Task or work;
it does not renew deadlines, ask for OAuth consent, publish Model Context, or
add polling, subscriptions or per-turn automatic cards. It uses the same valid
`environments:use` grant. Hosts without MCP Apps support receive honest ordinary
data without a promised card.

The template is linked by `_meta.ui.resourceUri` and read through
`resources/read`; `resources/list` remains the live Environment directory.
The UI is optional; ordinary results remain usable without it. It needs neither
Tasks nor Events. The template URI is `ui://agentenv/workbench-v2.html`, versioned to avoid
reusing the previous context-publishing template.

This matrix controls our advertised entrypoints, not ChatGPT's view identity.
An explicit `show_workbench` asks for a new card near its current tool result,
so the user need not scroll to an older card. Actual placement is host-dependent
and requires post-deployment validation in #210. A repeated launcher may create
another independent iframe. There is no pinned/floating card guarantee. Sharing
a URI does not merge cards, and a chat tool result does not automatically update an older
card. Host presentation outside this metadata is host-dependent. In-card
`app.callServerTool` responses update only that card, without asking for a new
view. No cross-iframe synchronization, global ordering or polling is invented.

The workbench shows an explicitly dated snapshot, not a live monitor. Selecting
an Environment or clicking **Refresh** performs one read. There is no
automatic query, retry, subscription or background model wakeup. The local clock
only updates relative timestamps. Tool results
replace the displayed snapshot. Viewing the workbench does not renew deadlines.

Final command outcomes have a compact evidence panel above the unchanged literal
logs. Success means a terminal command exit of zero with no signal or stop reason;
it does not certify the user's broader objective. Nonzero exits, signals,
cancellation, timeout, truncation and historical results remain distinct from
Environment availability. A historical selected result does not describe or stop
the active operation. Whole-workspace `workFinished` can be false while that
selected historical operation is terminal.

Only owner-authorized MCP tool `structuredContent`, delivered through the host
tool-result bridge, supplies evidence. Schema checks validate shape, not identity
or authorization. Model text, parsed JSON strings and output resources cannot
establish command status. Missing or inconsistent command evidence retains the
existing Markdown/literal-log display. Generated evidence includes only bounded
machine fields, never excerpts of stdout, stderr or Agent prose. Cancelled Tasks
currently omit command outcomes; their cancellation label and available literal
output snapshot remain visible without inventing exit or signal evidence.

To view command evidence from chat, launch the Workbench with
`show_workbench` to go directly to the sole owned live Environment. To browse,
use `list_environments` and select the Environment. Refresh explicitly as needed.
Zero-argument show selects the current server operation, not an older card’s
historical selection; it cannot recover that selection across views. To select a
retained historical result, choose **查看操作结果** and enter its operation ID from the
chat tool result. Stop continues to target the active operation independently.
The authenticated snapshot is still the only evidence source.

The default composer sends Agent requests. **运行命令** accepts a JSON array of
literal argv, with no shell parsing or expansion, in cwd `.`. UI bounds are
1–64 arguments, 2048 characters per argument, 8192 input characters and an
integer timeout of 1–300 seconds. These are frontend bounds, not a change to
the server command contract. A user can explicitly invoke a shell through argv;
there is no shell added by the card. Do not enter credentials. Command argv,
logs and prompts never enter Model Context. The UI receives no credentials.
An unconfirmed command retains its original canonical argv, timeout and
idempotency key for an explicit retry; editing cannot silently submit different
work with that key. A confirmed rejection permits a new submission. Passive
results and refresh do not end a submission lease.

**在对话中使用此工作区** is the only context-publication action. It
capability-checks `ui/update-model-context` and publishes only stable
`environmentId`, with no operation ID, timestamp, status, logs, prompt or
credentials. Empty lists, capacity refusals, tool notifications, selections and
refreshes publish nothing. The action waits for host acknowledgement, reports
failure or unsupported capability visibly, and suppresses overlapping requests
while one is in flight. Every later explicit click publishes again, including
returning to card A after selecting card B. A card cannot know the host’s
current selection from its own earlier acknowledgement. It sends no chat
message or work request.

Acknowledgement means the bridge accepted the request, not that a model used it.
This temporary Model Context is distinct from ChatGPT Saved Memory and tool
results. Its scope, lifetime, replacement and ordering across cards depend on
the host. A late passive result from any card cannot publish a selection. A
person can explicitly select a different card, but the bridge offers no global
ordering guarantee; no card can prove which selection is current elsewhere.
Use authenticated `inspect_environment` for current facts.
Unsupported hosts retain all tool/card operations.

**Answer in ChatGPT** sends a user-requested `ui/message` for an unsupported
question form. Host approval and capability rules still apply.
MCP Apps discovery and local AppBridge rendering are fixture checks; opening
cards in real ChatGPT and native Tasks result handoff require independent host
acceptance in [#210](https://github.com/Harness-X-Harness/runner/issues/210).

Buttons use the same authenticated tools as chat. The component receives no
OAuth token and makes no direct network connections. Native question forms submit
the exact question and operation IDs through `update_operation`; unsupported
form layouts can be answered in chat using the same tool. **Stop operation**
keeps the Environment; **Close environment** ends its runner and loses temporary
workspace files. Both require explicit confirmation. A pending stop or close
does not imply terminal state. Progress, final output and historical operations
remain distinct, and a completed Agent response does not certify its objective.

The UI follows host theme variables and uses the standard MCP Apps bridge, not
host-name detection or a separate execution model. Its source is in
[`ui/`](../apps/chatgpt-app/ui/); `npm run build:ui --prefix apps/chatgpt-app`
bundles its HTML resource before tests, development or deployment. The generated
`dist/` directory is disposable and is not committed. When making a breaking
template change, update its resource URI so clients do not reuse incompatible UI.

### Events client

Clients that support the MCP Events webhook draft can subscribe independently
of Tasks. `server/discover` advertises `events: {}`; `events/list` describes
`environment.updated`. Use `events/subscribe` with `arguments.environmentId`,
`delivery: {mode: "webhook", url, secret}`, and `cursor: null` on the same
authenticated `/mcp` endpoint. `secret` is a Standard Webhooks `whsec_` key
containing 24–64 decoded bytes. `Mcp-Name` matches the event name for subscribe
and unsubscribe.

Harness checks ownership and verifies the HTTPS callback before activation.
Without an unexpired verification for the same Principal and callback URL,
it sends a fresh signed challenge. Successful verification is cached for ten
minutes; reusing it does not extend its expiry. The ID is deterministic for the
Principal, callback URL, event name and canonical arguments. Repeated subscription calls
refresh that ID. The default lifetime is one hour, with a one-minute minimum
and 24-hour maximum; `ttlMs: null` still receives a finite lifetime. Refresh
before the returned `refreshBefore`. Unsubscribe uses the same name, arguments
and callback URL, without a signing secret, and returns `{}` idempotently.

Notifications contain only Environment ID, revision, kind and state, plus an
operation ID for input-required or terminal operations. They report initial
state, first readiness, confirmed closure, and operation input-required,
completed, failed or cancelled changes. They contain no prompt, question body,
output, credential or T3 pairing link. Read `inspect_environment` for current
details when a notification arrives. Completed means native execution finished,
not that the business objective was certified.

Subscription state and the outbox persist in the existing Environment object.
The source transition and notification commit together. There are at most eight
subscriptions and 256 pending deliveries per Environment. Overflow drops the
oldest notification, not business state. Events are non-replayable (`cursor:
null`); authoritative results remain readable under the normal retention rule.
Delivery is best effort, can be duplicated or reordered, and makes at most five
attempts with exponential backoff. `410`, `413` and permanent client errors are
not retried. Event IDs and occurrence times stay fixed across attempts;
signing time and signature are fresh. Grant expiry, observed revocation,
subscription expiry or unsubscribe stops later delivery. OAuth KV revocation
visibility is eventual. An already-started network request cannot be recalled.

ChatGPT supports this webhook subset. A `2xx` proves callback receipt, not
that ChatGPT followed the user's instructions. Rescan the plugin after an event
catalog change and verify actual conversation continuation separately. No
polling, Events SSE, `gap` or `terminated` notifications are implemented.
See [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events).

| Tool | Purpose |
| --- | --- |
| `open_environment` | Allocate a bounded workspace for Codex or Grok |
| `agent` | Send another prompt to its native Agent session |
| `command` | Run argv directly in the same workspace without a model |
| `inspect_environment` | Read current Environment and operation state once |
| `list_environments` | Browse live owned Environments across clients |
| `show_workbench` | Display/resume the existing workspace HERE without starting work |
| `update_operation` | Answer questions or cancel one operation, keeping the Environment |
| `close_environment` | Stop the exact runtime and confirm cleanup |

These tools require fresh `environments:use` consent. Refresh does not add
authority. Valid grants are reused across deployments. The client declaration
selects the Tasks contract or the ordinary receipt before execution. There is
no silent switch and no polling loop. Desktop resource display, notifications,
cards, and automatic model continuation are outside the ordinary contract and
still require separate host support.

`inspect_environment.agent` is the runner's last reported model state, with an
observation time and a `current` flag bound to the ready runtime generation.
The full model directory is returned on inspection and Environment resources,
not repeated in mutation receipts. Completed operation outcomes still include
their native-confirmed model and effort.
`models` comes from the provider directory; it is not proof of CLI acceptance.
Null means discovery is unavailable, not that a fallback model was selected.
`defaults` is the deployment pair; `selection` is the native-confirmed locked
pair. `uncertain` means native configuration may have partially changed and a
new Environment is needed for agent work. Disconnected/closed snapshots are
historical. A selected operation's result still describes that operation only.
Neither inspection nor these observations renews idle or hard deadlines.

The runner sends WebSocket protocol Ping every 30 seconds on its authenticated
connection. If the next interval has no Pong, it retires that socket and uses
the existing reconnect path with the same Environment and runtime identity.
This detects silent transport loss; it does not poll MCP state, restart work,
confirm execution stop, or renew idle/hard deadlines. Cloudflare responds to
protocol Ping without invoking the Durable Object's message handler.

`inspect_environment.reconnectDiagnostic` and the Environment resource can
include the current connection observation as `{category, observedAt}`. The time
is the control plane's observation time. It records only authenticated socket
facts: `transport_closed`, `transport_failure`, or a local
`control_plane_rejected` message. It contains no raw error, token, URL, runtime
identity or public failure history. A successful current ready generation clears
it; an old generation cannot restore it. An absent fact does not identify a
cause. Runner identity acquisition and HTTP/bootstrap handshake failures are
operator evidence when they cannot reach the control plane with reliable
authenticated evidence. Production workflows retain only coalesced reconnect
failure categories and observation times; native stdout/stderr remains private.
Socket closure logs also retain the numeric WebSocket `closeCode`, never its
free-form reason. This operator field is not part of the MCP snapshot.
The diagnostic does not close an Environment, release
capacity, change retry policy, or renew its idle/hard deadline. Explicit close
still uses the Principal's Execution Authorization and exact-run stop evidence.

An Environment permits one active Agent/command operation. Resource links expose
bounded owner-private state and output; URI change notifications trigger reads.
Reading a snapshot replaces previously displayed content rather than appending
it. A completed Agent turn does not certify the user's business objective.
Repository and PR work remains the Agent's responsibility, not a fixed pipeline.
See [runtime](development/command-runtime.md) and [admission](development/environment-admission.md).

## Identity and authority

- **Principal:** the stable GitHub numeric user ID. It owns the Task across
  that user's MCP clients.
- **MCP grant:** one client's OAuth authorization. It grants Task access but
  does not change the fixed Agent credential's target-repository rights.
- **Execution:** one admitted GitHub workflow run and attempt. Signed OIDC
  claims must match the trusted runner configuration and Task owner.
- **Agent GitHub identity:** `AGENT_GITHUB_TOKEN`, injected as `GH_TOKEN` only
  into execution. It is not the Principal's scoped control-plane token.

Each Environment has a `BoundedEnvironmentObject`, with owner checks, one
execution binding and immutable terminal operation results. The admission
authority owns the bounded live membership, not Task results or history.
`AuthorizationStateObject` stores one-time consent and callback state;
`OAUTH_KV` belongs only to the OAuth provider.

Only trusted users should receive Task access. The Agent deliberately has the
fixed token's repository rights. Omitting Actions OIDC variables from its child
environment is not process isolation on the shared runner user account.

## OAuth and GitHub App

Harness is the OAuth authorization server for MCP clients. It uses OAuth 2.1,
PKCE, canonical resource binding, client ID metadata documents and a compatible
dynamic client registration endpoint. The Harness consent page and GitHub's
user authorization page are separate boundaries.

CIMD requires the Worker to fetch and validate the client's public metadata.
If that lookup fails before consent, Harness returns a local HTTP 503 page
without redirecting to an unverified callback or creating consent state. It
does not bypass validation or switch to DCR automatically. Restore metadata
access before repeating CIMD authorization; an operator can separately choose
the existing DCR registration mode in a client that supports it.

The GitHub App user flow uses S256 PKCE and browser-bound, one-time callback
state. After GitHub returns a base user token, Harness scopes it to the runner
repository and `Actions: write`. The base access token is not retained. The
encrypted OAuth grant stores the refresh token and expiry, scoped token and
expiry, GitHub Principal and Harness scopes. Refresh derives a new
scoped token.

GitHub callback failures distinguish code exchange from workflow-token scoping.
Diagnostics include only the stage, upstream HTTP status when available, and a
fixed error category. They omit credentials, callback parameters and raw upstream
responses. Callback state is consumed once; a failed attempt needs a new authorization.

There is no App JWT, installation token, PAT, OAuth `repo` scope or alternate
identity for control-plane workflow authority. The separate fixed Agent PAT
never enters OAuth grants or Worker callback payloads. Shared provider secrets
also stay out of MCP input/output, Actions logs and public configuration.

The source of truth for Worker variables and bindings is
[wrangler.jsonc](../apps/chatgpt-app/wrangler.jsonc). The required GitHub App
client secret, `GITHUB_APP_CLIENT_SECRET`, is loaded privately. Workflow identity
is checked by the callback authority, not a second deployment variable.

## Deployment and acceptance

Use the [Task Live Story](agents/live-stories/task-runtime.md) for bounded
production acceptance and the [operations runbook](runner-operations-runbook.md) for secret-safe
deployment and local checks. After a Task change, validate the changed boundary
through authenticated discovery and a representative real Task. Provider or
GitHub write changes also need the affected native/provider or private-repository
acceptance; static tests alone do not prove those external effects.

When fresh consent is needed, give the user a link and wait. Reuse an existing
valid Task grant. Do not open a browser or repeat authorization on the user's
behalf. Keep private live evidence outside Git and public documentation.
