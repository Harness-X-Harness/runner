# Private T3 session

This public repository starts a one-time GitHub-hosted Ubuntu runner for a
private repository, optionally joins it to Headscale, and serves that checkout
through T3 Code and a temporary Cloudflare Quick Tunnel.

The workflow is deliberately declarative and happy-path:

- Codex uses its official standalone installer.
- Claude Code uses its official native installer.
- T3 Code runs with `npx --yes t3@latest`.
- cloudflared uses Cloudflare's official package repository and system default
  install location.
- Tailscale uses its official Linux installer.

The main workflow declares the session in three local composite actions:
development tools, private network, and T3 session. There is
no development-tool cache, fixed multi-language bootstrap, custom tool home, or
shell wrapper for these commands. Target-project dependencies remain the target
project's responsibility after connection and should follow that project's own
documentation.

Service readiness depends on the connection values emitted by the native
processes, not a fixed startup delay. Dependency-free local Node actions model
that wait and the Lark card lifecycle directly.

## Configure a session Environment

Create a protected GitHub Environment for each target repository. Its name is
visible in the Actions UI, so use a non-sensitive identifier. Configure these
Environment secrets:

| Secret | Purpose |
| --- | --- |
| `TARGET_REPO` | Private repository in `owner/repository` form |
| `TARGET_REPO_AUTH` | Token restricted to that repository |
| `HEADSCALE_AUTHKEY` | Tagged ephemeral Headscale/Tailscale auth key, when SSH is enabled |

Configure `HEADSCALE_URL` as a repository or Environment secret when SSH is
enabled. The workflow only accepts `workflow_dispatch`, has read-only GitHub
token permissions, and uses a path-scoped temporary Git credential store.

The Lark session card requires the `LARK_APP_ID`, `LARK_APP_SECRET`, and exact
`LARK_CHAT_NAME` secrets. See [Lark session card](docs/lark-reporting.md).

Protect both the default branch and every session Environment. In particular,
restrict Environment deployment branches and require reviewers before granting
secrets to workflow runs.

When SSH is enabled, configure Headscale using the repository's
[config example](headscale/config.example.yaml) and
[policy example](headscale/policy.example.hujson). They are fragments to merge
into the deployed configuration, not drop-in production files. Replace the
example identities and addresses, then validate all fields against the deployed
Headscale version. The policy should only permit trusted administrators to reach
tagged runners over Tailscale SSH.

## Start and connect

Dispatch **Private T3 Session**, select the session Environment, and set
`enable_ssh=true` when private shell access is needed. The runner uses
Tailscale SSH:

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Private connection data is mode `0600` under:

```text
~/private-runner-session/t3code/connection.txt
```

The file records the Cloudflare public origin and the pairing URL emitted by
T3 itself. The workflow never constructs or rewrites pairing URLs. It publishes
the native pairing URL only in the non-forwardable Online Lark card and removes
it when the card becomes Offline; it never writes that URL to Actions logs,
summaries, or artifacts. If external pairing requires an explicit public origin,
use the upstream T3 configuration intended for that purpose instead of rewriting
its output.
The Quick Tunnel URL and all runner state disappear when the session ends.

## Failure behavior

The workflow models the happy path. Commands keep their native output and exit
status. It has no retry, fallback installer, cache restore, custom error code,
or diagnostic-artifact layer.

## Local validation

```bash
bash tests/workflow-security.test.sh
node --test tests/lark-session.test.js
node --test tests/await-log.test.js
shellcheck --severity=warning tests/*.sh
actionlint
```

See the [operations runbook](docs/runner-operations-runbook.md) for the concise
operator flow and [SECURITY.md](SECURITY.md) for the current trust model.

For ChatGPT-driven code tasks, see the [ChatGPT code-task app](docs/chatgpt-app.md).
Verified cross-cutting facts and documentation ownership are indexed in
[project memory](project-memory.md).
It adds a stable Cloudflare Worker `/mcp` control plane while keeping the
existing temporary T3 session workflow available as a separate path.
