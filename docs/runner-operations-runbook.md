# Private development environment operations

## Start an environment

Call `open_environment` from the connected ChatGPT app and open its stable
Environment URL. The control plane dispatches **Private Development
Environment** with one signed generation and one opaque owner concurrency
slot. The workflow uses the fixed `session--none` GitHub Environment. It
claims its exact run through GitHub OIDC before loading credentials or starting
private interfaces. It then creates an empty
`$HOME/workspace`, joins Headscale, and starts T3 through a Quick Tunnel.

## Connect

With the default Tailscale SSH mode:

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Read the private connection data after connecting:

```bash
cat ~/private-runner-session/t3code/connection.txt
```

The file is mode `0600`. After all connections are ready, the authenticated
Environment entry redirects its owning user to T3's native pairing flow. Do
not copy pairing data to Actions output, artifacts, chat, or public tracking
systems.

Use the environment like a personal temporary Linux machine. Authenticate
tools and clone or create repositories after connection. Call
`close_environment` when finished. If ChatGPT is unavailable, cancel the same
GitHub run directly. The platform run limit is the other termination path.

## Failure behavior

This repository follows the happy path. Native commands keep their normal
output and exit status; the workflow has no custom retry, timeout, fallback, or
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
Calling `open_environment` while Starting, Ready, or Closing observes only that
exact run. If GitHub confirms it terminal, the same request creates one
replacement generation; if the run is still live or the lookup is unavailable,
it returns the current phase and does not dispatch.
If that exact-run lookup is temporarily unavailable, the entry request can
fail, but it does not rewrite Environment state. Refresh it after GitHub
recovers; do not use an empty list or a failed lookup to start another run.

This is not exactly-once network delivery. GitHub does not accept an
application idempotency key for workflow dispatch. Safety comes from an
at-most-once dispatch attempt, the early generation gate, owner-slot workflow
concurrency, and exact-run cancellation. No empty workflow listing or `5xx`
response is treated as proof that GitHub created no run.

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
