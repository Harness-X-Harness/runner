# Private development environment

[![Codex auth](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/codex-auth.yml)
[![Grok auth](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml/badge.svg)](https://github.com/Harness-X-Harness/runner/actions/workflows/grok-auth.yml)

This public repository starts one user-owned, temporary GitHub-hosted Ubuntu
development machine. It always joins Headscale for Tailscale SSH and serves an
empty workspace through T3 Code and a temporary Cloudflare Quick Tunnel.

The workflow is deliberately declarative and happy-path:

- Codex uses its official standalone installer.
- Claude Code uses its official native installer.
- Grok Build uses its official native installer.
- T3 Code runs with `npx --yes t3@latest`.
- cloudflared uses Cloudflare's official package repository and system default
  install location.
- Tailscale uses its official Linux installer.

The main workflow declares the environment through local actions for
development tools, private network, T3, readiness, and one-shot Lark delivery.
There is no development-tool cache, fixed multi-language bootstrap, custom tool
home, or shell wrapper for these commands. The workflow does not clone a repository.
Users authenticate tools, clone zero or more projects, and follow each
project's own documentation after connection.

Service readiness depends on the connection values emitted by the native
processes, not a fixed startup delay. Dependency-free local Node actions model
that wait and send one ready connection card.

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
| `LARK_APP_ID` | Lark custom application ID |
| `LARK_APP_SECRET` | Lark custom application secret |
| `LARK_CHAT_NAME` | Exact destination chat name |

The workflow only accepts zero-input `workflow_dispatch` and has read-only
GitHub token permissions.

The LarkSend card requires the `LARK_APP_ID`, `LARK_APP_SECRET`, and exact
`LARK_CHAT_NAME` secrets. See [LarkSend connection card](docs/lark-reporting.md).

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

Dispatch **Private Development Environment**. The workflow has no inputs. The
runner uses Tailscale SSH:

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
construct pairing URLs. After all connections are ready, LarkSend publishes one
non-forwardable card containing the native pairing URL. It never writes that
URL to Actions logs, summaries, or artifacts, and the card is not updated when
the run ends.
The initial workspace is `$HOME/workspace`. The user manages its repositories,
credentials, and processes directly. Cancel the GitHub run when finished. The
Quick Tunnel URL and all runner state disappear when the run ends or reaches
the GitHub-hosted platform limit.

## Failure behavior

The workflow models the happy path. Commands keep their native output and exit
status. It has no retry, fallback installer, cache restore, custom error code,
or diagnostic-artifact layer.

## Local validation

```bash
bash tests/workflow-security.test.sh
node --test tests/lark-send.test.js
node --test tests/await-log.test.js
shellcheck --severity=warning tests/*.sh
actionlint
```

See the [operations runbook](docs/runner-operations-runbook.md) for the concise
operator flow and [SECURITY.md](SECURITY.md) for the current trust model.

For ChatGPT-driven code tasks, see the [ChatGPT code-task app](docs/chatgpt-app.md).
It adds a stable Cloudflare Worker `/mcp` control plane while keeping the
temporary development-environment workflow as a separate path.
Public-repository analysis runs without installing the GitHub App. Private
repositories and write modes request repository installation only when their
required access is missing; the original task remains waiting and resumes only
after GitHub user and installation permissions are verified.
