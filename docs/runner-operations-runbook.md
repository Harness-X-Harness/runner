# Private development environment operations

## Start an environment

Dispatch **Private Development Environment**. The workflow has no inputs and
uses the fixed `session--none` GitHub Environment. It creates an empty
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

The file is mode `0600`. After all connections are ready, LarkSend sends one
non-forwardable card containing the pairing URL to the configured trusted
group. Do not copy it to Actions output, artifacts, any other chat, or public
tracking systems.

Use the environment like a personal temporary Linux machine. Authenticate
tools and clone or create repositories after connection. Cancel the GitHub run
when finished. The platform run limit is the only other termination path.

## Failure behavior

This repository follows the happy path. Native commands keep their normal
output and exit status; the workflow has no custom retry, timeout, fallback, or
diagnostic-artifact layer.

LarkSend has no update or cleanup lifecycle. The ready card remains a record of
the delivered connection; GitHub Actions is authoritative for current run
status.

## Local checks

```bash
bash tests/workflow-security.test.sh
node --test tests/lark-send.test.js
node --test tests/await-log.test.js
shellcheck --severity=warning tests/*.sh
actionlint
```

## Live acceptance

After a merged change affects this environment path, follow
[Live Story: Private Development Environment](agents/live-stories/private-development-environment.md).
It separates autonomous probes from the user-owned Lark and T3 pairing gates
and requires cleanup of the temporary runner.
