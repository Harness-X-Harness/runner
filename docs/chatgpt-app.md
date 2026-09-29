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
   Agent turns share the workspace and native session. Use standard Task
   subscriptions for state and result, `tasks/update` for requested input, and
   `tasks/cancel` for cooperative cancellation.
4. Call `close_environment` and observe completion. A closing status is not
   confirmation of stopped execution or released capacity.

A Tasks client keeps this contract. A missing or failed Task result is not
replaced with an ordinary receipt.

### Ordinary client

A client that does not declare Tasks calls the same tools. The result is an
ordinary acceptance receipt and the current status. It is not a Task handle and
not proof that the work finished.

1. `open_environment` returns the Environment ID and current status, such as
   `opening`.
2. `command` returns a finished command result when one is already committed.
   Otherwise it returns an operation ID and status `working`.
3. `agent` returns an operation ID and status `working`.
4. `inspect_environment` reads one Environment. It reports status, the active
   operation and its pending questions when one exists, and one selected
   operation when `operationId` is supplied. The selected operation does not
   hide the active operation.
5. `close_environment` can return `closing`. Inspect when a person asks. Only
   status `closed` confirms cleanup.

Call `inspect_environment` when a person asks for the current state. Do not
poll. This contract has no subscription, streamed output, automatic model
continuation, card, or answer submission. Waiting for input is visible, but it
is not success and cannot be answered here.

| Tool | Purpose |
| --- | --- |
| `open_environment` | Allocate a bounded workspace for Codex or Grok |
| `agent` | Send another prompt to its native Agent session |
| `command` | Run argv directly in the same workspace without a model |
| `inspect_environment` | Read current Environment and operation state once |
| `close_environment` | Stop the exact runtime and confirm cleanup |

These tools require fresh `environments:use` consent. Refresh does not add
authority. Valid grants are reused across deployments. The client declaration
selects the Tasks contract or the ordinary receipt before execution. There is
no silent switch and no polling loop. Desktop resource display, notifications,
cards, and automatic model continuation are outside the ordinary contract and
still require separate host support.

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
