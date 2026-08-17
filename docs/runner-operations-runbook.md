# Private development environment operations

## Start an environment

Call `open_environment` from the connected ChatGPT app and open its stable
Environment URL. The control plane dispatches **Private Development
Environment** with one opaque correlation input. The workflow uses the fixed
`session--none` GitHub Environment. It creates an empty
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
stores ownership, exact run identity, private delivery, and close intent.

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
