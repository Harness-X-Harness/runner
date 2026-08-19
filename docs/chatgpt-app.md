# Harness X Harness MCP app

Harness X Harness gives one GitHub user a temporary private development
Environment and long-lived Codex or Grok Agent Sessions inside that
Environment. The stable MCP endpoint is:

```text
https://runners.trustedtunnel.app/mcp
```

The Cloudflare Worker is the control plane. GitHub-hosted runners are the
temporary execution plane. Agent Sessions are the only code-agent execution
interface.

## User flow

1. Connect an MCP client to the endpoint and authorize these Harness scopes:
   `environments:manage` and `sessions:manage`.
2. GitHub verifies the user through the dedicated GitHub App. Harness derives
   one user token limited to `Harness-X-Harness/runner` and `Actions: write`.
3. Call `start_session` with Codex or Grok and the user's first task. If the
   user has no active Environment, the same operation reserves one Session,
   starts one Environment, and delivers that task after admission.
4. The admitted workflow starts Tailscale, T3, and one multiplexed Session
   runtime. The Session becomes `idle` or `running` without another open call.
5. Send ordinary turns through the MCP client's conversation. The Session
   Widget streams recent output and exposes only the current structured request
   or lifecycle action. All nine Session tools remain available to natural-
   language clients.
6. `stop_session` stops only that native conversation. `close_environment`
   terminates all Sessions in that Environment and cancels the exact GitHub
   run.

The user can also call `open_environment` to get the T3 entry without starting
an Agent Session.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `start_session` | Start one Codex or Grok Session and send its required first task |
| `list_sessions` | List the user's Sessions without transcript events |
| `read_session` | Read one snapshot and ordered events after a cursor |
| `send_turn` | Send exact text as explicit `steer` or `queue` delivery |
| `cancel_queued_turn` | Cancel one exact turn before it starts |
| `interrupt_turn` | Interrupt one exact active turn |
| `respond_to_session` | Answer one declared approval, question, or authorization request |
| `take_over_session` | Transfer future writes to the caller's MCP Grant |
| `stop_session` | Stop one native conversation |
| `open_environment` | Open or resume the user's private Environment |
| `close_environment` | Close the Environment and every Session in its generation |

All Session tools require `sessions:manage`. Environment tools require
`environments:manage`. Harness does not duplicate GitHub repository, issue, or
pull-request scopes. A user authenticates `gh`, Git, or another GitHub client
inside the private Environment when an Agent needs repository authority.
Harness does not receive that credential.

## Identity and authority

- **Harness Principal:** stable GitHub numeric user ID. It owns one Environment
  and all Sessions created through any of the user's MCP clients.
- **MCP Grant:** one authorization held by one client. It has a random
  controller ID and a display name.
- **Session Controller:** the one Grant allowed to mutate a Session. The owner
  can explicitly take control from another Grant.
- **Environment Run:** one exact GitHub Actions run. GitHub is lifecycle
  authority; the Durable Object stores the owner, generation, exact run, and
  close intent.
- **Environment generation:** freshness boundary for callbacks, WebSocket
  channels, commands, events, and Sessions. An older generation cannot revive
  or control a newer Environment.

One `EnvironmentObject` Durable Object serializes Environment and Session state
for one GitHub Principal. `AuthorizationStateObject` stores one-time consent and
GitHub callback state. `OAUTH_KV` is used only by the OAuth provider.

## OAuth and GitHub App

Harness is the OAuth authorization server for MCP clients. It uses OAuth 2.1,
PKCE, canonical resource binding, dynamic client registration, and client ID
metadata documents. The Harness consent page and GitHub's user authorization
page are separate boundaries.

The GitHub App user flow uses S256 PKCE and browser-bound, one-time callback
state. After GitHub returns a base user token, Harness uses the App's token
scoping endpoint to derive a token limited to:

```text
repository: Harness-X-Harness/runner
permission: Actions write
```

The base access token is not retained. The encrypted OAuth grant stores only
the refresh token, its expiry, the scoped Environment token, its expiry, the
GitHub Principal, Harness scopes, and MCP controller identity. Refresh derives
a new scoped token. There is no App JWT, installation token, PAT, OAuth `repo`
scope, or fallback execution authority.

Required Worker configuration:

| Name | Type | Purpose |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | variable | GitHub App user authorization |
| `GITHUB_APP_CLIENT_SECRET` | secret | code exchange, refresh, and token scoping |
| `ENVIRONMENT_SESSION_SECRET` | secret | browser Environment state and Session stream capabilities |
| `GITHUB_RUNNER_REPOSITORY` | variable | trusted execution repository |
| `GITHUB_ENVIRONMENT_WORKFLOW_ID` | variable | Environment workflow |
| `GITHUB_RUNNER_REF` | variable | protected dispatch ref |
| `TASK_CONTROL_PLANE_URL` | variable | canonical Worker origin and OIDC audience |

The historical `TASK_` prefix in `TASK_CONTROL_PLANE_URL` and the deployed
Worker service name are stable infrastructure identifiers. They do not expose
a Code Task product.

## Runtime channel and drivers

The admitted runner opens one outbound WebSocket to its owner
`EnvironmentObject`. GitHub OIDC is sent only in the WebSocket subprotocol
handshake. The channel binds exact repository, workflow, ref, run, attempt, and
generation. It multiplexes commands, acknowledgements, bounded semantic
events, and lifecycle transitions for all Sessions in that Environment.

Commands are durable and at-least-once. A command ID gives idempotent native
effects. Events use one monotonic cursor. Reconnect replays unacknowledged
commands and reads events after the last cursor.

- Codex uses one native `codex app-server` thread per Session.
- Grok uses one native ACP stdio session per Session.
- Drivers normalize only user-visible text, bounded activity, lifecycle, safe
  requests, and errors.
- Raw reasoning, complete stdout/stderr, native payloads, provider endpoints,
  prompts, credentials, and T3 pairing data are not retained as Session Events.

The default working directory is `/home/runner`. Harness does not clone a
repository or run fixed checkout, test, commit, push, or pull-request stages.
The Environment is a private temporary machine; the user directs the Agent and
establishes any needed GitHub login inside it.

## Session Widget and private stream

The versioned `ui://session/v3.html` resource is a consumer and narrow command
surface, never a state authority. It renders the authoritative Session snapshot
and the five most recent user-visible event groups without nested scrolling or
a duplicate conversation input. Its contextual action area contains at most
one primary and one secondary action. The snapshot includes server-computed
`allowedActions` and exact `allowedTurnDeliveries`; the Widget does not recreate
controller, phase, or channel eligibility rules.

`start_session` always carries the first task. Later turns use the MCP client's
native conversation and `send_turn`, so the inline Widget does not need a
second composer.

Every displayed mutation calls the same MCP tool used by natural-language
clients. A client can observe a newer snapshot through the stream before an
older tool response arrives. The Widget therefore applies Session snapshots by
monotonic `latestCursor`; a lower-cursor response cannot replace a newer view.
The displayed controller is the client's latest observation, not a lock or a
second authority.

Both versioned Widgets use the shared MCP Apps bridge for tool calls and links.
ChatGPT's optional `window.openai.theme` and `openai:set_globals` signals only
adapt system color semantics; clients without those extensions keep the same
functional card through CSS `color-scheme`.

Single-Session tool results put a ten-minute encrypted Session stream
capability only in private `_meta`. It is bound to owner, Session, and Grant.
It is never in structured content, text, a URL, a log, or a durable event. The
Widget sends it as a Bearer token to `/session-stream/<session_id>`, resumes from
the last cursor, deduplicates events, and obtains a fresh capability through
`read_session` after expiry. Takeover makes an old Grant unable to write even
if its read stream is still open.

## Environment lifecycle

`start_session` and `open_environment` share one Environment creation
transaction. Repeated calls return the same active generation. A request made
while the old run is Closing reserves one replacement generation; read/open
progresses it after GitHub confirms the exact old run is terminal.

An unknown dispatch outcome does not release ownership or dispatch again. An
early OIDC claim can recover a run whose dispatch response was lost. Close
revokes an unclaimed generation or cancels the exact known run. Late callbacks
and old channels cannot revive a closed generation.

## Deployment and checks

```bash
cd apps/chatgpt-app
npm ci
npm exec tsc -- --noEmit
npx wrangler deploy --dry-run
npx wrangler deploy
```

Repository checks:

```bash
node --test tests/*.test.js
bash tests/workflow-security.test.sh
shellcheck --severity=warning tests/*.sh
actionlint -color
git diff --check
```

After a merged production change, follow the private Environment Live Story and
the Agent Sessions acceptance ticket. Browser authorization, T3 pairing,
multi-user isolation, multi-client takeover, native request handling, and
in-Environment GitHub login require human participation.
