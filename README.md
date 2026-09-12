# Harness X Harness Task Runner

[![Codex auth](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml)
[![Grok auth](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml)

Give Codex or Grok a prompt. Harness starts one temporary GitHub-hosted Ubuntu
runner and returns the Agent's final response. Put repository access, issues,
code changes and PR instructions in the prompt; the Agent performs that work.
Harness does not impose a clone, test, commit or PR pipeline.

## Use from an MCP client

Connect to `https://runners.trustedtunnel.app/mcp` and authorize `tasks:manage`.

```text
run_task({ executor: "codex", prompt: "Read owner/repo and explain its architecture. Do not change files." })
wait_task({ taskId: "<returned Task ID>" })
cancel_task({ taskId: "<returned Task ID>" })
```

Use `codex` or `grok`. Save the returned Task ID: there is no Task list API.
Wait returns a snapshot, with final text or a safe error when terminal. It can
wait up to 25 seconds; repeat it if work is still active. A new `run_task` call
starts new work, not a retry of the previous Task.

There is no Task widget, stream, conversation, T3 link or automatic resubmission.
An existing grant with `tasks:manage` remains valid. Older Environment/Session
grants need new consent; refresh does not add Task authority.

## Runtime and credentials

The stable Cloudflare Worker authenticates the MCP user, stores one private
Task in a Durable Object and dispatches [run-task.yml](.github/workflows/run-task.yml).
GitHub OIDC binds claim and finish to the exact owner, workflow, run and attempt.

The workflow is declarative and happy-path. It installs only the selected CLI
through its current official installer and uses its default native home. There
is no tool cache, alternate installer, custom tool home or shell-wrapper layer.
A small Node Action handles private native protocol input and output.

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

Unclaimed work expires after ten minutes. GitHub bounds each job to sixty
minutes. Cancellation is a request to stop, not rollback; an accepted final
result or failure can win the race. Terminal results are owner-only and expire
after seven days.

If a runner loses its finish callback, a later nonzero wait can observe the
exact GitHub run and reconcile its terminal status. This needs the owner's
valid GitHub authority. There is no permanent background observer or result
recovery from logs. See the [Task contract](docs/development/task-runtime.md).

## Retained legacy data

New execution uses Tasks only. During the old data's retention window,
`list_sessions`, `read_session` and `close_environment` remain for existing
authorized clients. They cannot start an environment, submit turns or resume
work. Widgets, private streams and the old `/environment` entry are disabled.
Old storage is not deleted by this admission cutover.

## Validate and operate

```bash
npm ci --prefix apps/chatgpt-app
npm --prefix apps/chatgpt-app test
npm --prefix apps/chatgpt-app run typecheck
bash tests/workflow-security.test.sh
shellcheck --severity=warning tests/*.sh
actionlint
git diff --check
```

See the [MCP app contract](docs/chatgpt-app.md) and
[operations runbook](docs/runner-operations-runbook.md) for authorization,
deployment and bounded live acceptance.
