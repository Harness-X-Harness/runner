# Task Runner operations

## Task operation

After authorizing `tasks:manage`, use `run_task` with executor and prompt, then
`wait_task` with its returned Task ID. No target repository, branch, mode or
token is a separate tool input. `cancel_task` commits intent first and cancels
only its exact known GitHub run. A `cancelling` response is not an offline or
rollback guarantee; query again to observe the terminal result.

Unclaimed work expires after ten minutes even if a dispatch reply was lost.
The claim gate rejects late startup; there is no automatic second dispatch.
After an admitted run loses its finish callback, a nonzero `wait_task` or
`cancel_task` can reconcile the exact run/attempt using the owner's current
scoped GitHub authority. A zero-second wait returns stored state only. Revoked
authorization or unavailable GitHub evidence leaves execution status uncertain;
reconnect or query later, not with an alternate identity.

There is no unattended running-Task observer. With no later authorized query,
Task state can remain active after GitHub ends the run. GitHub's sixty-minute
job limit still bounds execution. Terminal results expire seven days after the
original terminal commit. Do not recover results from logs or artifacts.

## Legacy drain

Production sets `LEGACY_DRAIN_MODE=true`. Only Tasks admit new execution.
Existing authorized clients can use `list_sessions` and `read_session` for
retained terminal data, or `close_environment` for an exact old run. Old scopes
do not authorize Tasks. New environment, turn and queue requests are rejected;
the old browser entry, private stream and runner routes return HTTP 410.
Repeated close observes that exact run and returns Offline only after terminal
GitHub evidence. An unavailable observation leaves Closing; it cannot reopen.

Before activating this cutover, confirm that all admitted legacy runs have
ended. Do not cancel an unrelated run. A pending old dispatch can still arrive
at GitHub; the Durable Object claim gate prevents it from acquiring execution
credentials. Read requests cannot progress a reserved replacement. A late
dispatch response can still record exact ownership for cleanup but cannot admit
work. Cutover closes old control channels rather than preserving active native
conversations.

Keep the `EnvironmentObject` binding and storage for the existing terminal
read-retention window. No active GitHub run is not evidence that this window
has elapsed. Verify the latest retained terminal timestamps before a
destructive migration; earlier deletion needs explicit approval. A reviewed
source/deployment rollback is possible while storage remains, but it is not a
runtime fallback and must not automatically replay work. Deleting Durable
Object data cannot be undone by a source rollback.

## Deployment credentials

From the repository root, use the ignored `.secrets.env` file described by
[the credential example](../.secrets.env.example). Load only the two Cloudflare
deployment variables from that file; do not source or export the entire file.
With Node.js 22 or newer:

```bash
npm ci --prefix apps/chatgpt-app
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const local = parseEnv(readFileSync(".secrets.env", "utf8"));
const env = { ...process.env };
for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!local[name]) throw new Error(`${name} is missing from .secrets.env`);
  env[name] = local[name];
}
const result = spawnSync("npx", ["wrangler", "deploy", "--dry-run"], {
  cwd: "apps/chatgpt-app", env, stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
NODE
```

Remove `--dry-run` only for an authorized deployment. The configured Worker,
route, bindings and variables are owned by
[wrangler.jsonc](../apps/chatgpt-app/wrangler.jsonc); secret usage is owned by
the [Worker source](../apps/chatgpt-app/src/) and
[Task workflow](../.github/workflows/run-task.yml),
not a second configuration list in this runbook.

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

When `tasks:manage` consent is missing, provide the authorization link and wait
for the user. Reuse an existing valid Task grant; do not require another consent
only because a new version was deployed.

## Local checks

```bash
npm --prefix apps/chatgpt-app test
npm --prefix apps/chatgpt-app run typecheck
bash tests/workflow-security.test.sh
shellcheck --severity=warning tests/*.sh
actionlint
git diff --check
```

## Live acceptance

Use authenticated MCP discovery, then run a bounded prompt through
`run_task` and read its final response through `wait_task`. Verify the exact
`run-task.yml` execution and its terminal state. Test changed provider or
GitHub write boundaries in the approved disposable repository; do not repeat
unaffected acceptance matrices on every deployment.

Record private evidence in ignored local project memory. Confirm that created
runs have ended and clean up only the exact test branches, Issues and draft
PRs. Never publish prompts, raw protocol data, full logs, keys or provider URLs.
Static tests and configured Secret names are not end-to-end proof.
