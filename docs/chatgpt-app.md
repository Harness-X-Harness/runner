# Harness X Harness MCP app

Harness runs commands and interactive Codex or Grok turns in bounded Environments.
The stable MCP endpoint is `https://runners.trustedtunnel.app/mcp`. Cloudflare
owns authentication and Task state; GitHub owns the execution lifetime.

## User flow

1. Connect a modern Tasks-capable MCP client and authorize `environments:use`.
2. GitHub verifies the user through the dedicated GitHub App. Harness derives
   a user token limited to `Harness-X-Harness/runner` and `Actions: write`.
3. Call `open_environment` with `executor`. Subscribe to the returned Task and
   wait for ready. Save its Environment resource link, or discover live owned
   Environments with `resources/list` from another client of the same Principal.
4. Call `command` with literal argv and a timeout, or `agent` with a prompt.
   Agent turns share the workspace and native session. Use standard Task
   subscriptions for state/result, `tasks/update` for requested input and
   `tasks/cancel` for cooperative cancellation.
5. Call `close_environment` and observe completion. A closing status is not
   confirmation of stopped execution or released capacity.

| Tool | Purpose |
| --- | --- |
| `open_environment` | Allocate a bounded workspace for Codex or Grok |
| `agent` | Send another prompt to its native Agent session |
| `command` | Run argv directly in the same workspace without a model |
| `close_environment` | Stop the exact runtime and confirm cleanup |

These tools require fresh `environments:use` consent and the modern MCP Tasks
capability. Refresh does not add authority. Valid grants are reused across
deployments. Unsupported clients are rejected before execution, not silently
changed to polling. This release targets SDK clients; desktop resource display,
notifications and automatic model continuation require separate host support.

An Environment permits one active Agent/command operation. Resource links expose
bounded owner-private state and output; URI change notifications trigger reads.
Reading a snapshot replaces previously displayed content rather than appending
it. A completed Agent turn does not certify the user's business objective.
Repository and PR work remains the Agent's responsibility, not a fixed pipeline.
See [runtime](development/command-runtime.md) and [admission](development/environment-admission.md).

## Retained one-shot Tasks

`tasks:manage` only exposes `wait_task` and `cancel_task` for previously accepted
work. `run_task` is absent and cannot dispatch. This temporary path preserves
owner checks, exact-run cancellation, late completion and existing seven-day
result retention. It never creates an Environment or upgrades an old grant.
It is removed only after accepted work is drained and retained results expire;
see the [retained Task contract](development/task-runtime.md).

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
Retained one-shot Tasks remain in `TASKS` until their retention conditions permit
removal. `AuthorizationStateObject` stores one-time consent and callback state;
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
