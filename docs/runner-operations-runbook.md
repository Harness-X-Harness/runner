# Private runner operations

## Start a session

Dispatch **Private T3 Session** and choose the protected GitHub Environment
holding the target-repository secrets. Set `enable_ssh=true` for private shell
access. Set `non_durable=true` only when the workflow should finish after it
has started and reported T3 rather than remain available.

## Connect

With the default Tailscale SSH mode:

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Read the private connection data after connecting:

```bash
cat ~/private-runner-session/t3code/connection.txt
```

The file is mode `0600`. The Online Lark card also carries the pairing URL for
the configured trusted group. Do not copy it to Actions output, artifacts, any
other chat, or public tracking systems.

## Failure behavior

This repository follows the happy path. Native commands keep their normal
output and exit status; the workflow has no custom retry, timeout, fallback, or
diagnostic-artifact layer.

The Lark application-bot card moves from Starting to Online and is updated to
Offline by the action's native job teardown hook. Teardown is best-effort when a
runner is cancelled and cannot run after the runner itself disappears.

## Local checks

```bash
bash tests/workflow-security.test.sh
node --test tests/lark-session.test.js
node --test tests/await-log.test.js
shellcheck --severity=warning tests/*.sh
actionlint
```
