# Private development environment operations

## Start an environment

Call `open_environment` from the connected ChatGPT app and open its stable
Environment URL. The control plane dispatches **Private Development
Environment** with one signed generation and one opaque owner concurrency
slot. The workflow uses the fixed `session--none` GitHub Environment. It
claims its exact run through GitHub OIDC before loading credentials or starting
private interfaces. It then creates an empty `$HOME/workspace`, attempts the
optional Headscale attachment, and starts T3 through a Quick Tunnel. A failed
Headscale attachment does not block T3 or the Session runtime.

## Connect

When the optional Tailscale attachment succeeds:

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Read the private connection data after connecting:

```bash
cat ~/private-runner-session/t3code/connection.txt
```

The file is mode `0600`. After T3 and the Environment Control Channel are ready, the authenticated
Environment entry redirects its owning user to T3's native pairing flow. Do
not copy pairing data to Actions output, artifacts, chat, or public tracking
systems.

Use the environment like a personal temporary Linux machine. Authenticate
tools and clone or create repositories after connection. Call
`close_environment` when finished. If ChatGPT is unavailable, cancel the same
GitHub run directly. The platform run limit is the other termination path.

## Failure behavior

This repository follows the happy path. Native commands keep their normal
output and exit status. Only the optional Tailscale step uses GitHub's native
`continue-on-error`; core setup has no custom retry, timeout, fallback, or
diagnostic-artifact layer.

GitHub Actions is authoritative for current run status. The control plane only
stores ownership, generation admission, exact run identity, private delivery,
and close intent.

If GitHub rejects dispatch before it creates a run, `open_environment` reports
the failure and releases that generation. Do not retry while GitHub has a known
service outage.

If GitHub returns `5xx` or the response is lost, the tool returns Starting and
does not dispatch again. The stable entry says that GitHub has not confirmed
startup until the early OIDC claim supplies the exact run. If the workflow does
not claim, call `close_environment`. Closing an unclaimed generation returns
Offline and invalidates every delayed callback from that generation. A delayed
workflow can perform checkout, but it fails its claim before executor secrets,
Tailscale, T3, or Quick Tunnel setup.

The same user action applies if Cloudflare committed the generation but the
Worker did not receive the Durable Object response. A repeated open returns the
same unconfirmed generation and does not infer that dispatch is safe. Close it,
then open a new generation after the platform is healthy.

If an exact run is already known and cancellation cannot be delivered,
`close_environment` returns Closing and keeps the cancellation pending.
Repeating close can affect only that same run. The stable Environment entry
observes the exact run and changes to Offline after GitHub makes it terminal.
An explicit `open_environment` call while Starting, Ready, or Closing observes
only that exact run. If GitHub confirms it terminal, the same user request can
create one replacement generation; a live or unavailable observation cannot
dispatch.

The Environment card uses `open_environment({ operation: "observe" })` every ten
seconds while it waits. This mode can reconcile the exact run but cannot create
a generation or dispatch a workflow. If the original Open first returned
Closing, the card may issue one explicit replacement Open after terminal
evidence. It consumes that one replacement before observing the new Starting
run. A startup failure then becomes Offline; it never starts a second
replacement. A Close observed from any MCP client clears the card's local Open
intent. The Worker does not persist a user token or create a background reopen
job. `operation` is required, so cached clients that omit it cannot mutate the
Environment. A direct user Open uses `operation: "open"`.

A run that terminates before Ready ends its generation-bound Sessions with
`startup_failed`. A run that terminates after Ready uses `environment_ended`;
an explicit Close uses `stopped`.
If that exact-run lookup is temporarily unavailable, the entry request can
fail, but it does not rewrite Environment state. Refresh it after GitHub
recovers; do not use an empty list or a failed lookup to start another run.

This is not exactly-once network delivery. GitHub does not accept an
application idempotency key for workflow dispatch. Safety comes from an
at-most-once dispatch attempt, the early generation gate, owner-slot workflow
concurrency, and exact-run cancellation. No empty workflow listing or `5xx`
response is treated as proof that GitHub created no run.

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
[Environment workflow](../.github/workflows/private-runner-session.yml),
not a second configuration list in this runbook.

## Task acceptance preparation

This prepares the Task Runtime work tracked in
[#114](https://github.com/Harness-X-Harness/runner/issues/114); it does not
change the current Environment/Session product or its user-managed GitHub login.

Use the approved private disposable repository recorded in ignored local
project memory, with base branch `main` and unique `harness-acceptance/` branches
for authorized writes. Keep its actual identity and private acceptance evidence
out of public documents. Close test Issues and draft PRs, delete only the exact
temporary branches created by the check, and leave `main` unchanged. Do not use
the execution repository as a substitute write-test target.

The operator supplies `AGENT_GITHUB_TOKEN` privately for the future Task
execution step. It represents a fixed GitHub identity, not each Task caller.
Its target rights must be explicitly approved. Keep the value in ignored local
configuration or use GitHub CLI's private input prompt; do not put it in command
arguments:

```bash
gh secret set AGENT_GITHUB_TOKEN --repo Harness-X-Harness/runner
```

Run this only for an authorized initial setup or rotation; it replaces the
same-named Secret. Secret-name readback proves configuration exists, not that
the future runner consumed the correct value. Read-only API success is not
write acceptance. Never put token values or private acceptance output in logs,
Issues, artifacts or this runbook.

Fresh `tasks:manage` consent belongs to
[#123](https://github.com/Harness-X-Harness/runner/issues/123), after the new
scope/tools are deployed. Provide the authorization link and wait for the user.
Do not require another consent when the existing grant is already valid.

## Local checks

```bash
bash tests/workflow-security.test.sh
node --test tests/await-log.test.js
shellcheck --severity=warning tests/*.sh
actionlint
```

## Live acceptance

After a merged change affects this environment path, follow
[Live Story: Private Development Environment](agents/live-stories/private-development-environment.md).
It separates autonomous probes from the user-owned ChatGPT and T3 pairing gates
and requires cleanup of the temporary runner.
