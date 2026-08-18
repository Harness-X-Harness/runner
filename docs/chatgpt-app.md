# ChatGPT runner app

The repository now contains a separate Cloudflare Worker control plane under
`apps/chatgpt-app`. Its stable public endpoint is
`https://runners.trustedtunnel.app/mcp`; temporary GitHub runners remain the
execution plane. Remote Development Environments and Batch Code Tasks share
authentication and dispatch infrastructure, but keep separate product
interfaces and lifecycle state.

## Request flow

1. ChatGPT authenticates to the Worker through OAuth 2.1 + PKCE. The Worker
   uses the GitHub App for user identity and keeps the GitHub base user token,
   the derived Environment-scoped user token, and granted tool scopes encrypted in the OAuth provider
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
   the same task object. Codex and Grok also publish bounded, user-visible
   semantic events from their native JSON streams. Raw reasoning, command
   payloads, prompt text, and provider credentials are not published.
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

## Batch Code Task live output

`submit_task` renders one MCP Apps Task card. The card observes and controls
the existing one-shot task; it does not create a persistent Codex or Grok
conversation. The authoritative completion value remains the task's final
`result` published by the workflow.

Codex runs with native `codex exec --json` while keeping
`--output-last-message` as the final-result source. Grok runs with native
`--output-format streaming-json` and assembles its final result from the last
user-visible text segment after tool activity. One repository-owned Node Action consumes each driver's native
format. It publishes only user-visible Agent text, generic activity, and safe
task lifecycle snapshots. It does not publish model reasoning, raw commands,
prompt text, or provider credentials.

Before Codex starts, the fixed GitHub-hosted Ubuntu runner enables
unprivileged user namespaces and clears Ubuntu's AppArmor user-namespace gate
so the native bubblewrap sandbox can execute model-issued commands.

The Action batches events and authenticates each callback with GitHub Actions
OIDC. `TaskObject` assigns one monotonic sequence, retains the latest 256
events, and rejects driver events after `completed`, `failed`, or `cancelled`.
A reconnecting card supplies its last sequence and receives the retained
suffix. If that cursor predates the suffix, the card says that earlier live
events are no longer retained. This event history is not a durable transcript.

The Task card connects directly to the control plane through the MCP Apps CSP.
`submit_task` returns a random task-scoped read capability only in tool-result
metadata delivered to the card. It never appears in `structuredContent`, URLs,
Actions logs, or public task reads. The card sends it in the `Authorization`
header when reading `/task-stream/<task_id>`. It can open the exact GitHub run,
repository-installation action, or resulting pull request, and it uses the
existing `cancel_task` tool for cancellation.

`formal/TaskStream.tla` is a focused obligation model for monotonic cursors,
bounded ordered retention, final-result authority, terminal immutability, and
eventual delivery while a finite producer and connected observer remain
available. Its faulty configuration preserves the counterexample in which a
late driver event mutates the stream after terminal state.

## Remote Development Environment flow

`open_environment` has no input. The authenticated GitHub user is the owner
identity. A per-user `EnvironmentObject` enforces at most one active
Environment. It stores an opaque owner slot and generation before dispatch.
GitHub normally returns the exact run ID in the dispatch response. If that
response is lost or is a server error, the workflow can still claim its exact
run through GitHub OIDC. The tool returns only the stable
`https://runners.trustedtunnel.app/environment` entry plus a non-sensitive run
link when the exact run is known.

ChatGPT can render this result as one inline MCP Apps control card. The card
shows Starting, Ready, Closing, or Offline and offers only the actions valid
for that state: open the stable Environment entry, view the GitHub run, close
the Environment, or start a new one. The existing tools remain complete
without the card. The card has no storage, polling, or direct backend request;
the Worker and `EnvironmentObject` remain lifecycle authority. Pairing URLs,
T3 tokens, and Tailscale details are not sent to the card.

The card completes the MCP Apps `ui/initialize` handshake before accepting the
tool-result notification. Until that snapshot arrives, it shows Loading and
no actions. Environment and GitHub links use the host's standard
`ui/open-link` request. The versioned `ui://` resource URI changes whenever
the card protocol changes, so a refreshed ChatGPT connection cannot reuse an
incompatible cached resource.

The browser entry verifies GitHub identity independently. While the runner
starts, it displays Preparing. Immediately after checkout, the workflow uses
GitHub Actions OIDC to claim its repository, workflow, run, signed generation,
and Environment. This claim runs before executor credentials, Tailscale, T3,
or Quick Tunnel setup. After those interfaces are ready, a second OIDC callback
publishes the private descriptor for the already claimed run. The entry then
redirects the owner to T3's native pairing page. Pairing URLs, T3 origins,
Tailscale details, provider endpoints, and credentials never enter MCP output.

`close_environment` has no input. It records close intent, removes private
connection delivery, and cancels the exact recorded GitHub run. Repeated close
requests do not cancel another run. Cancellation responsibility remains pending
until GitHub accepts the request, so a failed delivery can be repeated only for
that same run. Before a run is claimed, close instead revokes the generation
and returns Offline. A delayed run then fails at the early claim gate. If the
dispatch response concurrently returns an exact run, the control plane binds
it only for cancellation. A delayed ready callback cannot restore a closed
descriptor.
When GitHub reports the run terminal, the Environment entry converges to
Offline. GitHub Actions remains lifecycle authority; users can cancel the run
directly if ChatGPT is unavailable.

An Open request with an exact recorded run first observes only that run through
GitHub. Confirmed terminal state converges the old generation and permits one
serialized replacement dispatch in the same request. A non-terminal or
unavailable observation returns the existing Starting, Ready, or Closing state
without dispatch. Close requests use the serialized Environment record and
cancel only its exact run. The stable browser entry applies the same terminal
observation before it redirects to T3.

### Distributed lifecycle and failure contract

The design separates four facts that cannot be made atomic across Cloudflare
and GitHub: local intent, dispatch effect, exact-run admission, and terminal
observation. GitHub's documented
[workflow-dispatch request](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
accepts a ref and workflow inputs and returns the exact run ID on success; it
does not expose an application idempotency key. Therefore, an absent or `5xx`
response is an unknown outcome and must not cause another dispatch. The early
claim is the recovery path for an accepted request; close is the recovery path
when no run claims the generation.

| Delayed or failed boundary | Stored authority | Observable result | Convergence path |
| --- | --- | --- | --- |
| ChatGPT request does not reach the Worker | No state changes | Client transport error | A later open is a new request |
| ChatGPT loses a completed tool response | Durable Object keeps the committed generation and run | Repeated open returns the same Environment | Serialized owner state prevents another dispatch |
| Duplicate or delayed `open_environment` | Per-user Durable Object | Same active Environment; no second dispatch | Serialized open claim |
| Durable Object rejects open before commit | No generation is committed | Tool error; no GitHub effect | Call open after the store is healthy |
| Durable Object commits open but its response is lost | Generation stays Dispatching and unconfirmed; no GitHub call is made | A later open returns Starting without dispatch | Close revokes the unconfirmed generation |
| GitHub rejects before creating a run | Generation becomes Offline | Tool reports the GitHub stage | A later open can create a new generation |
| GitHub accepts and returns run ID | Exact run is admitted | Starting with run link | Ready callback or GitHub terminal state |
| Dispatch response is lost or `5xx` | Generation stays Dispatching with unknown outcome | Starting, initially without run link | Early OIDC claim binds the run; close revokes the generation |
| Runner claim races with the unknown response | Claim transaction owns the exact run | Starting with run link | The late unknown marker is idempotent |
| Exact-run storage response is lost after commit | The run is already owned, or the early claim can still own it | Tool transport error or Starting | Repeated open reads the same record; no new dispatch |
| Duplicate workflow run for one owner | GitHub owner-slot concurrency plus generation gate | Only the current generation can be admitted | GitHub supersedes the old run; stale claim fails |
| Close races with dispatch | Generation revocation or exact-run close wins atomically | Offline before admission, Closing after admission | Late exact response is cancelled; late claim fails |
| Checkout or early claim fails | No sensitive setup is admitted | GitHub run fails; unknown generation can still show Preparing | User closes the unclaimed generation |
| Claim store fails before commit | No run is admitted and no sensitive setup starts | Workflow fails | User closes the unclaimed generation |
| Claim response is lost after storage commit | Exact run remains stored | Workflow fails before sensitive setup | Environment entry observes terminal GitHub state |
| Tool install, Tailscale, Tunnel, or T3 fails | Exact run remains stored | GitHub run fails | Environment entry observes terminal GitHub state |
| Ready callback is delayed or rejected | No new descriptor is published | Preparing or Offline | Exact generation and run checks reject stale delivery |
| Ready callback commits but its response is lost | Descriptor may exist briefly while the workflow fails | Entry checks GitHub before redirect | Terminal observation removes the descriptor and returns Offline |
| Open reads Starting or Ready after the exact run terminated | GitHub exact-run observation plus owner Durable Object | One replacement generation starts instead of returning stale active state | Terminal observation and serialized open occur in one request |
| Close storage response is lost | Revocation or `cancelPending` remains committed | Tool transport error | Repeated close is safe and can cancel only the same run |
| Close cancel response is lost or GitHub is unavailable | `cancelPending` remains on the exact run | Closing | Repeated close retries only that run; terminal observation clears it |
| Open arrives after close while the exact run is terminal | GitHub exact-run observation plus owner Durable Object | One replacement generation starts | Terminal observation and serialized open occur in one request |
| Open arrives after close while the run is live or observation fails | The old generation remains Closing | Closing; no replacement dispatch | A later Open can observe the same exact run again |
| User cancels in GitHub | GitHub is lifecycle authority | Entry changes to Offline | Exact-run observation in the stable entry |
| GitHub run lookup is delayed or unavailable | Durable Object state is not rewritten | Entry request fails without changing lifecycle | Refresh the stable entry after GitHub recovers |
| Browser identity expires | Environment state is unchanged | GitHub identity prompt | New browser session reads the same owner record |
| Another GitHub user opens the stable entry | Owner-keyed state is inaccessible | Offline page | No descriptor or run ownership crosses users |

Workflow-level
[concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
is keyed by an opaque, stable owner slot and uses `cancel-in-progress`. It
contains duplicate GitHub runs but does not replace the generation gate:
ordering of concurrent runs is not an identity or freshness proof. The
workflow keeps the native
[GitHub-hosted job limit](https://docs.github.com/en/actions/reference/limits);
the control plane adds no heartbeat, dispatch retry, fallback runner, or
cleanup worker.

The requirements model is in `formal/RemoteEnvironment.tla`. Its positive
configuration checks current-run admission, descriptor freshness, close
privacy, exact cancellation responsibility, GitHub run termination, and eventual
exit of an invalid generation. Separate faulty configurations preserve
counterexamples for stale descriptor publication, stale-run admission, and
premature loss of cancel responsibility.

`formal/EnvironmentReopen.tla` is a focused obligation model for concurrent
Open requests while an Environment has a known Starting, Ready, or Closing run. It keeps GitHub run reality,
the per-request observation (`terminal`, `live`, or `unknown`), committed
terminal evidence, and replacement dispatch ownership distinct. Its positive
configuration checks that only committed terminal evidence authorizes a
replacement and that two concurrent Open requests dispatch at most one new
generation. Three faulty configurations preserve counterexamples for treating a
live or unknown observation as terminal and for issuing a second replacement
dispatch, or for returning the old active generation after a terminal
observation. The controlled trace
`concurrent open after terminal evidence dispatches one replacement generation`
holds both GitHub observations at the same cut point, then proves the owner
Durable Object permits only one replacement dispatch.

| Model transition | Implementation seam |
| --- | --- |
| `Open` | `EnvironmentObject /environment/open` commits owner slot and generation before dispatch |
| `ReopenAfterTerminal` | `open_environment` confirms an exact Starting, Ready, or Closing run terminal, commits Offline, and serializes one replacement open |
| `DispatchRejected` | Typed pre-effect or non-ambiguous GitHub rejection calls `/environment/dispatch-failed` |
| `CommitDispatch` | Successful GitHub response calls `/environment/dispatch` with the exact run |
| `DispatchOutcomeUnknown` | Lost response, malformed success, `408`, or `5xx` calls `/environment/dispatch-unknown` without retry |
| `EarlyRunnerClaim` | First workflow callback uses OIDC and `/environment/claim` |
| `ReadyCallback` | Final workflow callback publishes the descriptor for the claimed generation and run |
| `CloseUnclaimed` | `/environment/close` revokes a dispatching generation without a run ID |
| `CloseKnownRun` / `CloseAdmitted` | Close hides the descriptor and retains exact-run `cancelPending` |
| `StaleRunStopsAtClaim` | A revoked or older generation receives `409` before sensitive setup |
| `GitHubRunTerminates` | GitHub makes the exact Environment run terminal independently of control-plane observation |
| `ObserveTerminal` | The authenticated Environment entry reads the exact terminal run and commits Offline |

The model proves application safety for every represented ordering, not the
availability of GitHub or Cloudflare. Its liveness claims use these explicit
external assumptions:

- GitHub validates one workflow-level concurrency group and eventually stops a
  superseded or terminal hosted run.
- A run that reaches the local lifecycle Action can obtain a GitHub OIDC token
  whose repository, workflow ref, branch, and run ID are authentic.
- The workflow stops when the early lifecycle Action returns non-success.
- GitHub eventually returns a successful exact-run read after a temporary API
  outage; until then, the control plane does not infer terminal state.
- A user closes an unclaimed generation that never reaches the early claim.
  There is intentionally no autonomous timer or liveness claim for that case.

Static workflow checks prove ordering in the checked-in workflow. They do not
prove GitHub service availability, Quick Tunnel availability, Tailscale control
plane availability, browser completion of GitHub login, or successful T3
pairing. Those claims remain scoped to the human Live Story after deployment.

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

`executor` currently accepts `codex` and `grok`. Each executor has an
independent workflow step and uses its current official installer. Codex and
Grok share `MINI_END_USER_KEY` while their confidential endpoints remain in
`MINI_CODEX_BASE_URL` and `MINI_GROK_BASE_URL`. Grok uses its native custom-model
configuration and does not use first-party login. `mode=analyze` leaves the checkout unchanged;
`edit` pushes a task branch; `pull_request` also creates a PR.

## Cloudflare setup

From `apps/chatgpt-app`, create the OAuth KV namespace. Put the returned
namespace ID in the `OAUTH_KV` binding, keep `GITHUB_APP_CLIENT_ID` in
`wrangler.jsonc`, and set the App credentials as Worker secrets:
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

GitHub App user authorization requests no traditional OAuth `repo` scope.
After GitHub issues the base user token, the Worker calls GitHub's scoped-token
endpoint and fixes the result to `Harness-X-Harness/runner` with only
`Actions: write`. The scoped-token exchange and the first real
`workflow_dispatch` decide whether that user may start an Environment. Harness
does not request organization membership or run a duplicate repository
permission preflight.

The encrypted MCP grant stores both tokens because the legacy Code Task still
uses the base token for target-repository authorization checks. Environment
tools accept only the derived scoped token. The Environment browser entry stores
only the scoped token inside a six-hour AES-GCM encrypted HttpOnly session so it
can observe the exact GitHub run. Neither token enters the runner, workflow
inputs, Widget, MCP structured output, logs, or artifacts. Grants from older
authorization models are rejected, so this migration requires one clean MCP
reconnection instead of a fallback.

For the legacy Code Task product, set the same GitHub App's post-installation
Setup URL as:

```text
https://runners.trustedtunnel.app/github/install
```

Enable **Redirect on update** so adding a selected target repository returns to the
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
MCP consent flow starts GitHub App user authorization explicitly, so an installation
must not redirect directly to the callback without the continuation state.

Set the `TASK_CONTROL_PLANE_URL` repository variable in the runner repository
to `https://runners.trustedtunnel.app`. The workflow uses that value as the
OIDC audience and callback base URL.

The Worker `TASK_CONTROL_PLANE_URL` value and the repository variable must be
byte-for-byte identical. Do not put the GitHub App client secret, GitHub App
private key, task prompt, or OIDC token in `wrangler.jsonc`, workflow
inputs, MCP structured content, logs, summaries, or artifacts.

Changing the control-plane origin also changes the OAuth issuer and canonical
`/mcp` resource. Update the GitHub App callback and setup URLs before deploying
the new origin, then reconnect MCP clients after deployment. Do not retain the
old `workers.dev` endpoint as a fallback.

Environment dispatch, readback, and cancellation use only the current
Principal's repository- and permission-scoped GitHub App user token. A missing,
expired, revoked, or unauthorized token fails that exact GitHub operation;
there is no base-user-token or installation-token fallback in the Environment
command path.

The legacy Code Task GitHub App still needs `Actions:
write` on the runner repository. The same App must be installed on target
repositories with the contents and pull-request permissions required by the
selected task mode. The workflow also needs the App ID as
`RUNNER_GITHUB_APP_ID` and the private key as
`RUNNER_GITHUB_APP_PRIVATE_KEY` in runner-repository secrets. GitHub reserves
the `GITHUB_` prefix, so these Actions secret names intentionally differ from
the Worker's `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` bindings. Configure
`MINI_END_USER_KEY`, `MINI_CODEX_BASE_URL`, and `MINI_GROK_BASE_URL` as runner
repository secrets. The native Codex CLI resolves the shared key and its secret
provider endpoint from its user config. Grok resolves the same key through
`env_key` in its native user config.
These credentials are scoped to their individual workflow steps and are not
needed by the Worker.

The Worker resolves the App installation from `GITHUB_RUNNER_REPOSITORY` before
each dispatch, then requests an installation token limited to that repository
and `Actions: write`. Do not configure or persist an installation ID manually.

The base GitHub App user token is also used by the legacy task preflight to verify
the submitting user's current access. A public `analyze` task does not require
a target-repository installation. Other modes must pass both user OAuth
authorization and current installation-permission checks. The App
installation token remains the short-lived task execution credential. The
target Agent Session architecture removes this complete Code Task installation
boundary instead of forwarding a user token into a runner.

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
