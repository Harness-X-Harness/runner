# Harness X Harness MCP app

Harness runs autonomous Codex or Grok Tasks on temporary GitHub-hosted runners.
The stable MCP endpoint is `https://runners.trustedtunnel.app/mcp`. Cloudflare
owns authentication and Task state; GitHub owns the execution lifetime.

## User flow

1. Connect an MCP client and authorize `tasks:manage`.
2. GitHub verifies the user through the dedicated GitHub App. Harness derives
   a user token limited to `Harness-X-Harness/runner` and `Actions: write`.
3. Call `run_task` with `executor` and `prompt`. Put the repository and all work
   instructions in the prompt. Save the returned Task ID.
4. Call `wait_task` for the final semantic response, or `cancel_task` to request
   a stop. A nonterminal wait can be repeated; a new run call creates new work.

| Tool | Purpose |
| --- | --- |
| `run_task` | Run one autonomous Codex or Grok task with the configured Agent credentials |
| `wait_task` | Read or briefly wait for an owned Task and its final response |
| `cancel_task` | Request cancellation of an owned Task and its exact known run |

These tools require `tasks:manage`. Refreshing an older grant does not add this
scope. Valid Task grants do not need new consent on each deployment. Discovery
marks run and cancel as destructive, non-read-only operations; arbitrary Agent
work is open-world. Wait is read-only.

Tasks have no interactive continuation, widget, stream or list API. Harness
does not impose checkout, issue, branch or PR tools: the Agent performs those
operations using the fixed GitHub credential inside its runner. Provider
completion proves a non-empty final response, not that the user's business
objective succeeded. The [Task runtime contract](development/task-runtime.md)
defines bounds, terminal races and conditional lost-finish reconciliation.

## Identity and authority

- **Principal:** the stable GitHub numeric user ID. It owns the Task across
  that user's MCP clients.
- **MCP grant:** one client's OAuth authorization. It grants Task access but
  does not change the fixed Agent credential's target-repository rights.
- **Execution:** one admitted GitHub workflow run and attempt. Signed OIDC
  claims must match the trusted runner configuration and Task owner.
- **Agent GitHub identity:** `AGENT_GITHUB_TOKEN`, injected as `GH_TOKEN` only
  into execution. It is not the Principal's scoped control-plane token.

Each Task has its own `TaskRuntimeObject` in `TASKS`, with owner checks, a
single execution binding and immutable terminal state. There is no global Task
index. `AuthorizationStateObject` stores one-time consent and GitHub callback
state; `OAUTH_KV` belongs only to the OAuth provider.

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

There is no App JWT, installation token, PAT, OAuth `repo` scope or alternate
identity for control-plane workflow authority. The separate fixed Agent PAT
never enters OAuth grants or Worker callback payloads. Shared provider secrets
also stay out of MCP input/output, Actions logs and public configuration.

The source of truth for Worker variables and bindings is
[wrangler.jsonc](../apps/chatgpt-app/wrangler.jsonc). The required GitHub App
client secret, `GITHUB_APP_CLIENT_SECRET`, is loaded privately. The Task workflow filename is defined in
the shared Task contract, not a second deployment variable.

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
