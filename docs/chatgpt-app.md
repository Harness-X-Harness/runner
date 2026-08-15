# ChatGPT code-task app

The repository now contains a separate Cloudflare Worker control plane under
`apps/chatgpt-app`. Its stable public endpoint is the Worker origin followed by
`/mcp`; the temporary GitHub runner remains the execution plane. The existing
Private T3 Session workflow is unchanged and can still be used independently.

## Request flow

1. ChatGPT authenticates to the Worker through OAuth 2.1 + PKCE. The Worker
   uses the configured GitHub App for user identity and keeps the GitHub user
   and refresh tokens plus granted tool scopes encrypted in the OAuth provider
   grant properties; every tool checks its required scopes again.
2. `submit_task` checks that the user can access the requested repository,
   stores the complete prompt in a per-task Durable Object, and dispatches
   `.github/workflows/execute-task.yml` in this repository through a GitHub App.
3. The workflow receives only `task_id`, `repo`, `ref`, `executor`, and `mode`.
   It obtains a short-lived GitHub Actions OIDC token, fetches the private
   prompt from `/internal/tasks/<task_id>`, and reports lifecycle events back to
   the same task object.
4. `get_task`, `get_task_result`, and `cancel_task` expose only the task's safe
   public fields. Prompt text, OAuth properties, and callback credentials never
   appear in MCP structured content.

The storage boundary is deliberate. The OAuth provider and short-lived
authorization state use the provider's required `OAUTH_KV` binding, while each
code task uses its own Durable Object for serialized lifecycle updates. D1 is
not part of the current design. See
[ADR 0001](adr/0001-oauth-kv-task-durable-objects.md) for the alternatives and
the conditions that would justify revisiting this choice.

The public tools are:

| Tool | Purpose | Side effect |
| --- | --- | --- |
| `submit_task` | Queue a code task | Starts a GitHub Actions run |
| `get_task` | Read current status | None |
| `cancel_task` | Request cancellation | Cancels a GitHub run when its run ID is known |
| `get_task_result` | Read summary, commit, or PR | None |

`executor` currently accepts `codex`, `claude`, and `grok`. Each executor has
an independent workflow step. Codex uses the pinned official Codex Action;
Claude Code and Grok Build use their current official installers. Grok Build
requires the `XAI_API_KEY` secret. `mode=analyze` leaves the checkout unchanged;
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
npx wrangler deploy
```

Copy `.secrets.env.example` to the ignored `.secrets.env` for local deployment
credentials. Use the same `CLOUDFLARE_API_TOKEN` for OAuth KV management and
Worker deployment; the project does not require separate tokens for individual
Cloudflare APIs. For a Workers.dev deployment, the token needs account
permissions `Workers Scripts: Edit`, `Workers KV Storage: Edit`, and
`Account Settings: Read`. A user-owned token also needs `User Details: Read`
and `Memberships: Read` for Wrangler identity checks. Zone permissions are only
needed if a custom domain or Worker route is added. `CLOUDFLARE_ACCOUNT_ID`
selects the account and is not a token.

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
https://runner.example.com/github/callback
```

Leave "Request user authorization (OAuth) during installation" disabled. The
MCP consent flow starts GitHub authorization explicitly, so an installation
must not redirect directly to the callback without the consent state. Keep
user-to-server token expiration enabled; the Worker rotates the upstream
GitHub token when the MCP client refreshes its grant.

Set the `TASK_CONTROL_PLANE_URL` repository variable in the runner repository
to the Worker origin, for example `https://runner.example.com`. The workflow
uses that value as the OIDC audience and callback base URL.

The Worker `TASK_CONTROL_PLANE_URL` value and the repository variable must be
byte-for-byte identical. Do not put the GitHub App client secret, private key,
task prompt, or OIDC token in `wrangler.jsonc`, workflow inputs, MCP structured
content, logs, summaries, or artifacts.

The GitHub App needs `Actions: write` on the runner repository so the Worker
can dispatch the workflow. The same App must be installed on target
repositories with the contents and pull-request permissions required by the
selected task mode. The workflow also needs the App ID as
`RUNNER_GITHUB_APP_ID` and the private key as
`RUNNER_GITHUB_APP_PRIVATE_KEY` in runner-repository secrets. GitHub reserves
the `GITHUB_` prefix, so these Actions secret names intentionally differ from
the Worker's `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` bindings. The Codex
executor uses the pinned official Codex Action with `CODEX_API_KEY` and the
full Responses endpoint in `CODEX_RESPONSES_API_ENDPOINT`. Put
`ANTHROPIC_API_KEY` and `XAI_API_KEY` there for the other executors you enable.
These credentials are scoped to their individual workflow steps and are not
needed by the Worker.

The Worker resolves the App installation from `GITHUB_RUNNER_REPOSITORY` before
each dispatch, then requests an installation token limited to that repository
and `Actions: write`. Do not configure or persist an installation ID manually.

The same GitHub App also issues a user access token after MCP consent. That
token is limited by both the user's access and the App's installation
permissions and is used only to verify access to the requested repository.
The App installation token remains the short-lived execution credential used
to dispatch the runner workflow and modify an installed target repository.
No separate GitHub OAuth App or broad `repo` OAuth scope is required.

All requests to `api.github.com`, whether authenticated by a user token, App
JWT, or installation token, use the shared GitHub headers including
`User-Agent: WeaverTaskRunner`. GitHub rejects REST requests without a valid
user agent. OAuth subjects passed to the pinned Cloudflare provider use
`github-<id>` because that provider's opaque authorization-code format uses
colon delimiters.

Current verified acceptance state and unresolved external checks are recorded
in [ChatGPT app acceptance memory](chatgpt-app-acceptance.md).

## Local checks

```bash
node --test tests/task-contract.test.js
npm --prefix apps/chatgpt-app run typecheck
npm --prefix apps/chatgpt-app run deploy -- --dry-run
```

The dry run validates the Worker bundle and Durable Object binding without
requiring a deployed KV namespace. A real deployment still requires replacing
the KV and Worker-variable placeholders and setting the secrets above.
