# Harness X Harness

[![Codex auth](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml)
[![Grok auth](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml)

Open a temporary GitHub-hosted Ubuntu Environment. Run commands directly or
send multiple prompts to Codex or Grok in the same workspace and native session.
The Agent handles repository access, issues, code and PRs; Harness does not
impose a clone, test, commit or PR pipeline.

## Use from an MCP client

Connect to `https://runners.trustedtunnel.app/mcp` and authorize `environments:use`.
Use a client implementing MCP 2026-07-28 Tasks and subscriptions. This release
targets SDK clients; tool discovery alone does not prove desktop-host Task,
resource-display or model-continuation support. There is no polling fallback.

```text
open_environment({ executor: "codex", idempotencyKey: "<unique creation key>" })
command({ environmentId: "<ready Environment ID>", argv: ["pwd"], timeoutSeconds: 10 })
agent({ environmentId: "<ready Environment ID>", prompt: "Explain this workspace. Do not change files." })
close_environment({ environmentId: "<Environment ID>" })
```

Use `codex` or `grok`. Long operations return a standard Task handle. Subscribe
to changes, answer requested input with `tasks/update`, and request a stop with
`tasks/cancel`. Reconnect reads current state without rerunning work.
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
official CLI, uses native configuration, executes a minimal request and discards
the model output. Grok does not use first-party login. Provider endpoints and
keys are secrets, not public configuration or Task results.

## Lifetime and cancellation

Startup is bounded to ten minutes. GitHub bounds each job to sixty minutes;
installation consumes that budget and the runtime reserves cleanup time.
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

```bash
npm ci --prefix apps/chatgpt-app
npm ci --prefix .github/actions/agent-runtime
node --test tests/*.test.ts
apps/chatgpt-app/node_modules/.bin/tsc --noEmit -p apps/chatgpt-app
.github/actions/agent-runtime/node_modules/.bin/tsc --noEmit -p .github/actions/agent-runtime
actionlint
git diff --check
```

See the [MCP app contract](docs/chatgpt-app.md) and
[operations runbook](docs/runner-operations-runbook.md) for authorization,
deployment and bounded live acceptance.
