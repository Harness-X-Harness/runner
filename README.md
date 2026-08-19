# Private development environment

[![Codex auth](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml)
[![Grok auth](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml)

This public repository starts one user-owned, temporary GitHub-hosted Ubuntu
development machine. It always joins Headscale for Tailscale SSH and serves an
empty workspace through T3 Code and a temporary Cloudflare Quick Tunnel.

The workflow is deliberately declarative and happy-path:

- Codex uses its official standalone installer.
- Grok Build uses its official native installer.
- T3 Code runs with `npx --yes t3@latest`.
- cloudflared uses Cloudflare's official package repository and system default
  install location.
- Tailscale uses its official Linux installer.

The main workflow declares the environment through local actions for
development tools, private network, T3, readiness, and the authenticated
Environment callback.
There is no development-tool cache, fixed multi-language bootstrap, custom tool
home, or shell wrapper for these commands. The workflow does not clone a repository.
Users authenticate tools, clone zero or more projects, and follow each
project's own documentation after connection.

Service readiness depends on the connection values emitted by the native
processes, not a fixed startup delay. Dependency-free local Node actions model
that wait and publish one private ready descriptor to the control plane.

## Configure the fixed Environment

The workflow uses the existing protected GitHub Environment `session--none`.
Configure this Environment secret:

| Secret | Purpose |
| --- | --- |
| `HEADSCALE_AUTHKEY` | Tagged ephemeral Headscale/Tailscale auth key |

Configure these repository secrets:

| Secret | Purpose |
| --- | --- |
| `HEADSCALE_URL` | Headscale control server URL |
| `MINI_END_USER_KEY` | Shared scoped bearer key used by Codex and Grok |
| `MINI_CODEX_BASE_URL` | Confidential Codex provider base URL |
| `MINI_GROK_BASE_URL` | Confidential Grok provider base URL |

The workflow accepts one opaque `environment_id` from the control plane. It
uses read-only repository permission plus `id-token: write` for its exact
GitHub OIDC-authenticated ready callback.

The two auth badges report separate daily native-CLI checks. Each workflow can
also be dispatched manually. It installs the current official CLI, loads the
provider endpoint and shared key through native user configuration, executes a
minimal model request, and discards the model output. No endpoint or key is
stored in the repository. Grok does not use first-party login.

Protect the default branch and restrict `session--none` deployment branches.

Configure Headscale using the repository's
[config example](headscale/config.example.yaml) and
[policy example](headscale/policy.example.hujson). They are fragments to merge
into the deployed configuration, not drop-in production files. Replace the
example identities and addresses, then validate all fields against the deployed
Headscale version. The policy should only permit trusted administrators to reach
tagged runners over Tailscale SSH.

## Start and connect

In ChatGPT, call `open_environment`. ChatGPT can show an inline Environment
card for opening or closing the session and viewing its GitHub run. The same
tool also returns the stable Environment URL when the client does not render
MCP Apps UI. After GitHub verifies the browser identity, the page shows
Preparing and then redirects to T3's native pairing flow. The runner also uses
Tailscale SSH:

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Private connection data is mode `0600` under:

```text
~/private-runner-session/t3code/connection.txt
```

The file records the Cloudflare public origin and a pairing URL issued by T3
for that origin. The workflow waits for the Quick Tunnel, then uses T3's native
`auth pairing create --base-url` command; it does not parse credentials or
construct pairing URLs. After all connections are ready, a GitHub
OIDC-authenticated callback publishes the descriptor to the user-owned Durable
Object. Pairing data never enters MCP results, Actions logs, summaries,
artifacts, or public documentation.
The initial workspace is `$HOME/workspace`. The user manages its repositories,
credentials, and processes directly. Call `close_environment` when finished,
or cancel the authoritative GitHub run directly if ChatGPT is unavailable. The
Quick Tunnel URL and all runner state disappear when the run ends or reaches
the GitHub-hosted platform limit.

## Failure behavior

The workflow models the happy path. Commands keep their native output and exit
status. It has no retry, fallback installer, cache restore, custom error code,
or diagnostic-artifact layer.

## Local validation

```bash
bash tests/workflow-security.test.sh
node --test tests/await-log.test.js
shellcheck --severity=warning tests/*.sh
actionlint
```

See the [operations runbook](docs/runner-operations-runbook.md) for the concise
operator flow and [SECURITY.md](SECURITY.md) for the current trust model.

For MCP-driven development, see the [Harness X Harness app](docs/chatgpt-app.md).
The same stable Worker exposes Remote Development Environments and interactive
Codex or Grok Agent Sessions. A Session card streams recent bounded private
output and presents at most two contextual actions. Ordinary turns stay in the
MCP client's conversation; structured requests, interruption, takeover, and
stop remain direct card controls. Harness does not clone a target repository or
create commits and pull requests through a fixed pipeline. Users establish any
needed GitHub login inside their private temporary Environment and direct the
Agent there.
