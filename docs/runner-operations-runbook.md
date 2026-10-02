# Harness operations

## Environment operation

Authorize `environments:use` with a modern Tasks-capable client. Use
`open_environment`, then `command` or `agent` after ready, and finally
`close_environment`. Subscribe to standard Tasks and Resources; use
`tasks/update` for input and `tasks/cancel` for operation cancellation. Keep the
exact Environment and Task handles. Uncertain delivery does not permit a new
creation key. See the [MCP contract](chatgpt-app.md).

An ordinary MCP client uses the same tools but receives acceptance receipts.
Read `inspect_environment` when a person asks for status. Do not poll. Do not
treat `closing` or waiting for input as success. The Tasks flow above remains
the subscription contract.
Use `update_operation` with exact operation/question IDs for answers or operation
cancellation. It does not close the Environment or create another Agent turn.

## Storage lifecycle

Applied migration tags are append-only. Check the deployed Worker and its exact
bindings before a migration. Preserve Task and authorization namespaces unless
their deletion is explicitly requested.

A [Cloudflare class-deletion migration](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#delete-migration)
deletes every object's data in that class. Source rollback cannot restore it.
Keep the OAuth provider's KV namespace and existing grant schema stable when
cleaning unrelated product code.

## Deployment credentials

From the repository root, use the ignored `.secrets.env` file described by
[the credential example](../.secrets.env.example). Load only the two Cloudflare
deployment variables from that file; do not source or export the entire file.
With Node.js 24 or newer:

```bash
npm ci --prefix apps/chatgpt-app
npm ci --prefix apps/event-delivery
npm run deploy --prefix apps/chatgpt-app -- --dry-run
```

Remove `--dry-run` only for an authorized deployment. The configured Worker,
route, bindings and variables are owned by
[wrangler.jsonc](../apps/chatgpt-app/wrangler.jsonc); secret usage is owned by
the [Worker source](../apps/chatgpt-app/src/) and
[Environment workflow](../.github/workflows/run-environment.yml),
not a second configuration list in this runbook.
Use this deployment command rather than invoking Wrangler directly. After a real
deployment it uses the script-level `/script-settings` API to set and read back
query-string redaction, disabled invocation logs and disabled traces. If
verification fails, code may already be deployed:
report that partial result, repair/read back the setting, and do not blindly
redeploy. Dry-run performs no settings writes. The owning implementation is
[deploy.ts](../apps/chatgpt-app/deploy.ts).
Script-level settings leave the deployed Worker version and Container enablement
unchanged; do not replace the Worker configuration through the legacy settings API.

The private [event-delivery Container](../apps/event-delivery/) also requires a
running Docker daemon and the account-scoped Containers and Cloudchamber write
permissions. A real deployment builds and publishes its pinned Linux/amd64
image. It has no public route and does not change the MCP endpoint. Its single
small instance sleeps after 30 idle seconds; cold startup can delay a delivery.
Containers require Workers Paid and incur resource usage charges; see
[Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/).
Worker deployment success does not prove that container provisioning or outbound
TLS is ready. Verify the actual changed-boundary path before claiming acceptance.
For this transport, verify a harmless HTTPS delivery, private-address rejection
and automatic idle exit. Sending a stop signal alone does not confirm exit.

## Private acceptance credentials

Use the approved private disposable repository recorded in ignored local
project memory, with base branch `main` and unique `harness-acceptance/` branches
for authorized writes. Keep its actual identity and private acceptance evidence
out of public documents. Close test Issues and draft PRs, delete only the exact
temporary branches created by the check, and leave `main` unchanged. Do not use
the execution repository as a substitute write-test target.

The operator supplies `AGENT_GITHUB_TOKEN` privately for the Task
execution step. It represents a fixed GitHub identity, not each Task caller.
Its target rights must be explicitly approved. Keep the value in ignored local
configuration or use GitHub CLI's private input prompt; do not put it in command
arguments:

```bash
gh secret set AGENT_GITHUB_TOKEN --repo Harness-X-Harness/runner
```

Run this only for an authorized initial setup or rotation; it replaces the
same-named Secret. Secret-name readback proves configuration exists, not that
the runner consumed the correct value. Read-only API success is not
write acceptance. Never put token values or private acceptance output in logs,
Issues, artifacts or this runbook.

When `environments:use` consent is missing, provide the authorization link and wait
for the user. Reuse an existing valid grant; do not require another consent
only because a new version was deployed.

## Local checks

Use Node.js 24 for these checks.

```bash
npm ci --prefix apps/chatgpt-app
npm ci --prefix .github/actions/agent-runtime
npm ci --prefix apps/event-delivery
npm run build:ui --prefix apps/chatgpt-app
node --test tests/*.test.ts
apps/chatgpt-app/node_modules/.bin/tsc --noEmit -p apps/chatgpt-app
.github/actions/agent-runtime/node_modules/.bin/tsc --noEmit -p .github/actions/agent-runtime
apps/chatgpt-app/node_modules/.bin/tsc --noEmit -p apps/event-delivery
actionlint
git diff --check
```

## Live acceptance

Follow the [Task Live Story](agents/live-stories/task-runtime.md). It is a
manual development acceptance guide, not another CI framework.

Use authenticated MCP discovery and the changed-boundary budget in the Story.
Observe results through standard Task subscriptions and linked Resources.
Verify the exact `run-environment.yml` execution and its terminal state. Test changed provider or
GitHub write boundaries in the approved disposable repository; do not repeat
unaffected acceptance matrices on every deployment.

For MCP Events use the Story's bounded webhook check. Rescan the plugin after
deploying a changed event catalog. No new OAuth scope, endpoint or consent is
needed. Callback verification and signed lifecycle delivery must pass before
claiming Events transport acceptance; actual ChatGPT continuation remains a
separate user-side check. Subscription expiry and queued retries share the
Environment alarm with lifecycle and retention; do not replace that alarm with
an independent timer or add client polling.

For connection diagnosis, application logs use `mcp.events.wire` for discovery
and Events requests. They contain only an allowlisted method, processing phase,
protocol category, HTTP status, numeric RPC error code, and discovery capability
or event count. `unlabelled` means the HTTP method header was absent; it does not
identify a client. No request body, identity, URL, callback, secret or result text
is recorded. These observations do not establish that ChatGPT consumed the
catalog or resumed a conversation. Keep invocation logs and traces disabled.
For an unsupported protocol, `mcp.protocol.rejected` also records the allowlisted
JSON-RPC method from the already parsed message and its numeric error code.
This separates `initialize` from a missing-header Events request without reading
the request stream again or recording parameters. Unknown method names are `other`.

Record private evidence in ignored local project memory. Confirm that created
runs have ended and clean up only the exact test branches, Issues and draft
PRs. Never publish prompts, raw protocol data, full logs, keys or provider URLs.
Static tests and configured Secret names are not end-to-end proof.
