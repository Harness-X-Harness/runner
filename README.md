# Harness X Harness

[![Codex auth](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml)
[![Grok auth](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml)

Open a temporary GitHub-hosted Ubuntu Environment. Run commands directly or
send multiple prompts to Codex or Grok in the same workspace and native session.
The Agent handles repository access, issues, code and PRs; Harness does not
impose a clone, test, commit or PR pipeline.

## Use from an MCP client

Connect to `https://runners.trustedtunnel.app/mcp` and authorize `environments:use`.
The protocol is MCP 2026-07-28. A client that declares Tasks receives Task
handles: subscribe to changes, answer input with `tasks/update`, and cancel
with `tasks/cancel`. A client that does not declare Tasks receives an ordinary
acceptance receipt and current status. Call `inspect_environment` when a person
asks; do not poll. Events-capable clients can subscribe to `environment.updated`
for signed lifecycle notifications without Tasks capability. Use `update_operation` to answer a question or cancel one
operation without closing the workspace. That contract has no subscription,
card, or automatic continuation. `closing` is not `closed`, and
waiting for input is not success. The declared capability is selected before
execution and is not switched after an error. Tool discovery does not prove
host support for Tasks, resources, or model continuation.

```text
open_environment({ executor: "codex", idempotencyKey: "<unique creation key>" })
inspect_environment({ environmentId: "<Environment ID>" })
command({ environmentId: "<ready Environment ID>", argv: ["pwd"], timeoutSeconds: 10 })
agent({ environmentId: "<ready Environment ID>", prompt: "Explain this workspace. Do not change files." })
close_environment({ environmentId: "<Environment ID>" })
```

Use `codex` or `grok`. A Tasks client gets a Task handle for long operations.
Reconnect reads current state without rerunning work. An ordinary client keeps
the returned Environment ID and operation ID, then inspects that same operation.
`resources/list` finds your live Environments; linked resources expose private
state and bounded output. Resource notifications trigger reads, not token streams.

Each Environment has one active Agent/command slot. Later Agent calls continue
the same native session. Reuse the same idempotency key and input for uncertain
submission; a new key is new work. There is no T3, Lark or widget dependency.
Environment access requires `environments:use` consent. See the
[MCP contract](docs/chatgpt-app.md).

## Runtime and credentials

The stable Cloudflare Worker authenticates the Principal, stores Environment
state in Durable Objects and dispatches [run-environment.yml](.github/workflows/run-environment.yml).
GitHub OIDC binds the runner connection to the exact owner, workflow, run and attempt.

The workflow is declarative and happy-path. It installs only the selected CLI
through its current official installer and uses its default native home. There
is no tool cache, alternate installer, custom tool home or shell-wrapper layer.
A TypeScript runtime uses the standard ACP SDK for native Agent interaction.

Configure these repository secrets:

| Secret | Purpose |
| --- | --- |
| `MINI_END_USER_KEY` | Scoped bearer key for the configured provider |
| `MINI_CODEX_BASE_URL` | Confidential Codex provider endpoint |
| `MINI_GROK_BASE_URL` | Confidential Grok provider endpoint |
| `AGENT_GITHUB_TOKEN` | Fixed GitHub identity and target-repository rights for the Agent |

Set the repository variable `TASK_CONTROL_PLANE_URL` to the canonical Worker
origin. Worker bindings and variables are owned by
[wrangler.jsonc](apps/chatgpt-app/wrangler.jsonc); deployment credential loading
is in the [operations runbook](docs/runner-operations-runbook.md).

The MCP user's scoped GitHub App token controls the runner repository. The
Agent instead receives the fixed `AGENT_GITHUB_TOKEN` as `GH_TOKEN`. It does
**not** inherit or enforce each caller's target-repository rights. Give Task
access only to users trusted with that fixed identity's authority. See
[SECURITY.md](SECURITY.md).

The auth badges run separate daily native-CLI checks. Each installs the current
official CLI, uses the production configuration and ACP adapter, confirms the
default model/effort, executes a minimal request and discards the model output.
These checks have no Agent GitHub token and do not prove GitHub writes or all
interactive behavior. Grok does not use first-party login. Provider endpoints and
keys are secrets, not public configuration or Task results.

## Lifetime and cancellation

Startup is bounded to ten minutes. GitHub bounds each job to six hours;
installation consumes that budget and the runtime reserves ten minutes for
cleanup, so the hard Environment deadline is five hours and fifty minutes
after the job starts.
An idle Environment closes after fifteen minutes. Input and CI waits still
consume the hard lifetime. Admission allows one Environment per Principal and
four globally; this is platform policy, not a measured GitHub quota.

Cancellation is intent, not rollback. Closing completes only after stop and
capacity release are confirmed. Closed Environments leave live discovery;
known Task/state/output resources remain owner-private for seven days after
closure. No results are recovered from workflow logs. See
[admission](docs/development/environment-admission.md) and
[runtime](docs/development/command-runtime.md).

## Validate and operate

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

See the [MCP app contract](docs/chatgpt-app.md) and
[operations runbook](docs/runner-operations-runbook.md) for authorization,
deployment and bounded live acceptance.
