# ChatGPT runner app

The repository now contains a separate Cloudflare Worker control plane under
`apps/chatgpt-app`. Its stable public endpoint is
`https://runners.trustedtunnel.app/mcp`; temporary GitHub runners remain the
execution plane. Remote Development Environments and Batch Code Tasks share
authentication and dispatch infrastructure, but keep separate product
interfaces and lifecycle state.

## Request flow

1. ChatGPT authenticates to the Worker through OAuth 2.1 + PKCE. The Worker
   uses the configured GitHub App for user identity and keeps the GitHub user
   and refresh tokens plus granted tool scopes encrypted in the OAuth provider
   grant properties; every tool checks its required scopes again. The local
   consent page explains each requested scope, supports explicit denial, and
   binds the following GitHub S256 PKCE flow to the initiating browser. Its
   short-lived browser-session cookie can bind multiple independent, one-time
   consent forms without one authorization attempt invalidating another.
2. `submit_task` resolves one repository access path before storing or
   dispatching the task. Public `analyze` uses `public_read`. Private reads and
   every write mode require a verified GitHub App installation. There is no
   retry, PAT, anonymous-after-token, or other fallback path.
3. When installation access is missing, the task is stored as
   `awaiting_installation` and returns one repository-specific authorization
   URL. The installation return starts GitHub user authorization again, verifies
   the original submitting user and current repository installation, then
   atomically claims the task for dispatch. An installation notification or
   callback parameter alone never grants authority.
4. The workflow receives only `task_id`, `repo`, `ref`, `executor`, `mode`, and
   the verified `repository_access` path.
   It obtains a short-lived GitHub Actions OIDC token, fetches the private
   prompt from `/internal/tasks/<task_id>`, and reports lifecycle events back to
   the same task object.
5. `get_task`, `get_task_result`, and `cancel_task` expose only the task's safe
   public fields. Prompt text, OAuth properties, and callback credentials never
   appear in MCP structured content.

The storage boundary is deliberate. The OAuth provider alone uses its required
`OAUTH_KV` binding. Consent, GitHub callback, and repository-installation state
use one strongly consistent `AuthorizationStateObject` Durable Object per
opaque state identifier. Each code task uses its own `TaskObject` Durable Object
for serialized lifecycle updates. Each GitHub user has one `EnvironmentObject`
for strong ownership, generation freshness, exact run identity, private
descriptor delivery, and close intent. D1 is not part of the current design. See
[ADR 0001](adr/0001-oauth-kv-task-durable-objects.md) for the alternatives and
the conditions that would justify revisiting this choice.

The public tools are:

| Tool | Purpose | Side effect |
| --- | --- | --- |
| `submit_task` | Queue a code task or request repository installation | Starts a run only when the required access path is verified |
| `get_task` | Read current status | None |
| `cancel_task` | Request cancellation | Cancels a GitHub run when its run ID is known |
| `get_task_result` | Read summary, commit, or PR | None |
| `open_environment` | Open or return the caller's one active Environment | Starts one runner when none is active |
| `close_environment` | Close the caller's active Environment | Cancels its exact GitHub run |

## Remote Development Environment flow

`open_environment` has no input. The authenticated GitHub user is the owner
identity. A per-user `EnvironmentObject` enforces at most one active
Environment, stores the exact GitHub run returned by workflow dispatch, and
returns only the stable `https://runners.trustedtunnel.app/environment` entry
plus a non-sensitive run link.

ChatGPT can render this result as one inline MCP Apps control card. The card
shows Starting, Ready, Closing, or Offline and offers only the actions valid
for that state: open the stable Environment entry, view the GitHub run, close
the Environment, or start a new one. The existing tools remain complete
without the card. The card has no storage, polling, or direct backend request;
the Worker and `EnvironmentObject` remain lifecycle authority. Pairing URLs,
T3 tokens, and Tailscale details are not sent to the card.

The browser entry verifies GitHub identity independently. While the runner
starts, it displays Preparing. After T3, Quick Tunnel, and Tailscale are ready,
the runner uses GitHub Actions OIDC to publish one descriptor for the exact
repository, workflow, run, signed generation, and Environment. The entry then
redirects the owner to T3's native pairing page. Pairing URLs, T3 origins,
Tailscale details, provider endpoints, and credentials never enter MCP output.

`close_environment` has no input. It records close intent, removes private
connection delivery, and cancels the exact recorded GitHub run. Repeated close
requests do not cancel another run. A delayed ready callback cannot restore a
closed descriptor. When GitHub reports the run terminal, the Environment entry
converges to Offline. GitHub Actions remains lifecycle authority; users can
cancel the run directly if ChatGPT is unavailable.

The initial MCP challenge and protected-resource metadata request the complete
App capability set. The single `submit_task` tool also declares every scope it
can use, including repository writes and pull-request creation. MCP tool
security declarations are static and cannot vary with the tool's `mode`
argument. This one-time full connection keeps the public interface small and
avoids a reconnect loop caused by parameter-level scope escalation.

The server still enforces the minimum scope set for the selected mode:
`analyze` requires task run and repository read; `edit` adds repository write;
`pull_request` also adds pull-request write. The authorization server displays
and grants exactly the validated scope set that the client requests.

Repository access remains independent: GitHub asks for installation or update
only when a task targets a repository the App cannot access.

## OAuth resource audience

The Worker binds OAuth grants and access tokens to the canonical MCP resource
`https://<control-plane-host>/mcp`, not to the bare Worker origin. The
`TASK_CONTROL_PLANE_URL` variable must therefore contain the deployed Worker
origin without a path; the Worker derives `/mcp` from it and publishes the
same authorization-server issuer. A token issued before this boundary change
may require one clean ChatGPT reauthorization. Do not restore an origin-only
comparison or delete the `OAUTH_KV` namespace during this migration. New
authorization and token requests must include this exact `resource` value. The
Worker rejects an omitted value before the provider processes it; the provider
keeps redirect-aware OAuth errors for repeated or different values.

`executor` currently accepts `codex`, `claude`, and `grok`. Each executor has
an independent workflow step. Codex uses the native official CLI; Claude Code
and Grok Build use their current official installers. Codex and
Grok share `MINI_END_USER_KEY` while their confidential endpoints remain in
`MINI_CODEX_BASE_URL` and `MINI_GROK_BASE_URL`. Grok uses its native custom-model
configuration and does not use first-party login. `mode=analyze` leaves the checkout unchanged;
`edit` pushes a task branch; `pull_request` also creates a PR.

## Cloudflare setup

From `apps/chatgpt-app`, create the OAuth KV namespace. Put the returned
namespace ID in the `OAUTH_KV` binding, set `GITHUB_APP_CLIENT_ID`, and set
`TASK_CONTROL_PLANE_URL` to the deployed Worker origin:

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler secret put ENVIRONMENT_SESSION_SECRET
npx wrangler deploy
```

Copy `.secrets.env.example` to the ignored `.secrets.env` for local deployment
credentials. Use the same `CLOUDFLARE_API_TOKEN` for OAuth KV management,
Worker deployment, and the fixed Custom Domain. Scope it to the Worker account
with `Workers Scripts: Edit`, `Workers KV Storage: Edit`, and
`Account Settings: Read`, plus `Workers Routes: Edit` on only the
`trustedtunnel.app` zone. Cloudflare creates the Custom Domain DNS record and
certificate; the token does not need DNS or certificate write permission. A
user-owned token also needs `User Details: Read` and `Memberships: Read` for
Wrangler identity checks. `CLOUDFLARE_ACCOUNT_ID` selects the account and is
not a token.

The deployment configuration binds exactly one public hostname,
`runners.trustedtunnel.app`, disables both `workers.dev` and preview URLs, and
uses that same origin as `TASK_CONTROL_PLANE_URL`. Per-runner hostnames are not
part of the control plane; temporary T3 access continues to use its independent
Quick Tunnel.

When validating `CLOUDFLARE_API_TOKEN`, use the endpoint matching its owner:

```text
cfut_...  user API token     GET /user/tokens/verify
cfat_...  account API token  GET /accounts/{account_id}/tokens/verify
```

Both token types can authenticate Wrangler. A `401` from only one of these
endpoints does not prove that the token is invalid; first verify its type and
retry against the matching endpoint without logging the token value. An
`active` verification result establishes token validity, not that it has every
Workers, KV, or Durable Objects permission required by deployment.

Set the GitHub App's user authorization callback URL as:

```text
https://runners.trustedtunnel.app/github/callback
```

Set its post-installation Setup URL as:

```text
https://runners.trustedtunnel.app/github/install
```

Enable **Redirect on update** so adding a selected repository returns to the
same continuation. The Worker does not trust GitHub's `installation_id` query
parameter. It uses the opaque task state only to locate the waiting task, then
queries GitHub again with the App JWT and completes a user authorization-code
flow with S256 PKCE before dispatch. The one-time GitHub OAuth state is stored
for ten minutes and is bound to the browser that started that flow. If an
organization owner approves the installation request in another browser, the
original submitter can use the same task authorization URL in their browser
after approval; the prompt and task parameters do not need to be submitted
again.

Leave "Request user authorization (OAuth) during installation" disabled. The
MCP consent flow starts GitHub authorization explicitly, so an installation
must not redirect directly to the callback without the consent state. Keep
user-to-server token expiration enabled; the Worker rotates the upstream
GitHub token when the MCP client refreshes its grant.

Set the `TASK_CONTROL_PLANE_URL` repository variable in the runner repository
to `https://runners.trustedtunnel.app`. The workflow uses that value as the
OIDC audience and callback base URL.

The Worker `TASK_CONTROL_PLANE_URL` value and the repository variable must be
byte-for-byte identical. Do not put the GitHub App client secret, private key,
task prompt, or OIDC token in `wrangler.jsonc`, workflow inputs, MCP structured
content, logs, summaries, or artifacts.

Changing the control-plane origin also changes the OAuth issuer and canonical
`/mcp` resource. Update the GitHub App callback and setup URLs before deploying
the new origin, then reconnect MCP clients after deployment. Do not retain the
old `workers.dev` endpoint as a fallback.

The GitHub App needs `Actions: write` on the runner repository so the Worker
can dispatch the workflow. The same App must be installed on target
repositories with the contents and pull-request permissions required by the
selected task mode. The workflow also needs the App ID as
`RUNNER_GITHUB_APP_ID` and the private key as
`RUNNER_GITHUB_APP_PRIVATE_KEY` in runner-repository secrets. GitHub reserves
the `GITHUB_` prefix, so these Actions secret names intentionally differ from
the Worker's `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` bindings. Configure
`MINI_END_USER_KEY`, `MINI_CODEX_BASE_URL`, and `MINI_GROK_BASE_URL` as runner
repository secrets. The native Codex CLI resolves the shared key and its secret
provider endpoint from its user config. Grok resolves the same key through
`env_key` in its native user config. Put `ANTHROPIC_API_KEY` there only when the
Claude executor is enabled.
These credentials are scoped to their individual workflow steps and are not
needed by the Worker.

The Worker resolves the App installation from `GITHUB_RUNNER_REPOSITORY` before
each dispatch, then requests an installation token limited to that repository
and `Actions: write`. Do not configure or persist an installation ID manually.

The same GitHub App also issues a user access token after MCP consent. That
token is limited by both the user's access and the App's installation
permissions and is used to verify access to the requested repository. A public
`analyze` task does not require a target-repository installation. Other modes
must pass both user authorization and current installation-permission checks.
The App installation token remains the short-lived execution credential used
to dispatch the runner workflow and modify an installed target repository.
No separate GitHub OAuth App or broad `repo` OAuth scope is required.

The runner repository also needs the variable `TASK_CONTROL_PLANE_URL` with the
same fixed origin. The Environment workflow receives only the opaque signed
`environment_id`; it does not receive a user prompt, repository, pairing URL,
or callback secret.

## Repository authorization states

The requirements model is in `formal/RepositoryAuthorization.tla`. It preserves
these product properties:

- public read access is valid only for `analyze`;
- unknown GitHub responses fail without selecting another access path;
- installation notification does not authorize dispatch;
- a waiting task must be verified by the original GitHub user;
- the Durable Object dispatch claim is single-use;
- late installation callbacks cannot revive a cancelled or dispatched task.

The checked positive model covers 107 distinct states. The durable faulty
configuration deliberately trusts an installation notification and violates
`AuthorizedDispatch`.

All requests to `api.github.com`, whether authenticated by a user token, App
JWT, or installation token, use the shared GitHub headers including
`User-Agent: HarnessXHarnessTaskRunner`. GitHub rejects REST requests without a valid
user agent. OAuth subjects passed to the pinned Cloudflare provider use
`github-<id>` because that provider's opaque authorization-code format uses
colon delimiters.

## Local checks

```bash
node --test tests/*.test.js
npm --prefix apps/chatgpt-app run typecheck
npm --prefix apps/chatgpt-app run deploy -- --dry-run
```

The dry run validates the Worker bundle and Durable Object binding without
requiring a deployed KV namespace. A real deployment still requires replacing
the KV and Worker-variable placeholders and setting the secrets above.
