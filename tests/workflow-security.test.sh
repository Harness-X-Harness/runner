#!/usr/bin/env bash
# Contract checks for public-repo safety and authenticated Environment delivery.
# These are policy assertions over workflow YAML, not behavioral tests.
# Implementation details (installer URLs, package versions) belong elsewhere.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/private-runner-session.yml"
CODEX_AUTH_WORKFLOW="$ROOT_DIR/.github/workflows/codex-auth.yml"
GROK_AUTH_WORKFLOW="$ROOT_DIR/.github/workflows/grok-auth.yml"
TOOLS_ACTION="$ROOT_DIR/.github/actions/development-tools/action.yml"
T3_ACTION="$ROOT_DIR/.github/actions/t3-session/action.yml"
AWAIT_ACTION="$ROOT_DIR/.github/actions/await-log/action.yml"
ENVIRONMENT_ACTION="$ROOT_DIR/.github/actions/environment-control/action.yml"
ENVIRONMENT_SCRIPT="$ROOT_DIR/.github/actions/environment-control/index.js"
SESSION_RUNTIME_ACTION="$ROOT_DIR/.github/actions/session-runtime/action.yml"
SESSION_RUNTIME_SCRIPT="$ROOT_DIR/.github/actions/session-runtime/index.js"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$WORKFLOW" ]] || fail "missing workflow: $WORKFLOW"
[[ -f "$CODEX_AUTH_WORKFLOW" ]] || fail "missing workflow: $CODEX_AUTH_WORKFLOW"
[[ -f "$GROK_AUTH_WORKFLOW" ]] || fail "missing workflow: $GROK_AUTH_WORKFLOW"
for action in "$TOOLS_ACTION" "$T3_ACTION" "$AWAIT_ACTION" "$ENVIRONMENT_ACTION" "$SESSION_RUNTIME_ACTION"; do
  [[ -f "$action" ]] || fail "missing composite action: $action"
done
for removed in \
  "$ROOT_DIR/.github/workflows/execute-task.yml" \
  "$ROOT_DIR/.github/actions/task-control" \
  "$ROOT_DIR/.github/actions/task-driver" \
  "$ROOT_DIR/apps/chatgpt-app/src/task-object.js" \
  "$ROOT_DIR/apps/chatgpt-app/src/task-store.js" \
  "$ROOT_DIR/apps/chatgpt-app/src/task-stream.js" \
  "$ROOT_DIR/apps/chatgpt-app/src/task-widget.js" \
  "$ROOT_DIR/apps/chatgpt-app/src/repository-authorization.js"; do
  [[ ! -e "$removed" ]] || fail "legacy Code Task surface still exists: $removed"
done
if rg -q 'submit_task|get_task_result|cancel_task|tasks:|repos:|pull_requests:' \
  "$ROOT_DIR/apps/chatgpt-app/src"; then
  fail 'MCP source still exposes legacy Code Task tools or scopes'
fi

# GitHub Actions is the complete environment lifecycle. The workflow claims
# its run through OIDC before sensitive setup, then opens one outbound channel.
grep -Fq 'workflow_dispatch:' "$WORKFLOW" || \
  fail 'private environment must use manual workflow dispatch'
grep -Fq '      environment_id:' "$WORKFLOW" || \
  fail 'private environment workflow must receive one opaque Environment identity'
grep -Fq '      environment_owner:' "$WORKFLOW" || \
  fail 'private environment workflow must receive one opaque owner slot'
grep -Fq 'group: private-environment-${{ inputs.environment_owner }}' "$WORKFLOW" || \
  fail 'private environment workflow must contain duplicate runs by owner slot'
grep -Fq 'cancel-in-progress: true' "$WORKFLOW" || \
  fail 'a newer owner generation must supersede an older workflow run'
grep -Fq 'environment: session--none' "$WORKFLOW" || \
  fail 'private environment must use the fixed session--none profile'
grep -Fq 'uses: tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8' "$WORKFLOW" || \
  fail 'private environment must join the private network through the SHA-pinned official action'
[[ "$(grep -Fc 'continue-on-error: true' "$WORKFLOW")" == 1 ]] || \
  fail 'only the optional private-network step may tolerate failure'
grep -Fq 'authkey: ${{ secrets.HEADSCALE_AUTHKEY }}' "$WORKFLOW" || \
  fail 'private environment must authenticate to Headscale with its environment secret'
grep -Fq -- '--login-server=${{ secrets.HEADSCALE_URL }}' "$WORKFLOW" || \
  fail 'private environment must select the configured Headscale control server'
grep -Fq -- '--accept-dns=false --ssh' "$WORKFLOW" || \
  fail 'private environment must keep host DNS and enable Tailscale SSH'
grep -Fq 'version: latest' "$WORKFLOW" || \
  fail 'private environment must use the latest stable Tailscale release'
[[ ! -e "$ROOT_DIR/.github/actions/private-network/action.yml" ]] || \
  fail 'the official Tailscale action must not be hidden behind a local wrapper'
if rg -q 'apt-get update' "$ROOT_DIR/.github/actions" "$ROOT_DIR/.github/workflows"; then
  fail 'GitHub-hosted workflows must not refresh unrelated system package sources'
fi
grep -Fq 'uses: ./.github/actions/t3-session' "$WORKFLOW" || \
  fail 'private environment must always start T3'
[[ "$(grep -Fc 'uses: ./.github/actions/environment-control' "$WORKFLOW")" == 1 ]] || \
  fail 'private environment must claim the exact run once'
[[ "$(grep -Fc 'uses: ./.github/actions/session-runtime' "$WORKFLOW")" == 1 ]] || \
  fail 'private environment must use one long-lived Session runtime'
if grep -Fq 'phase: ready' "$WORKFLOW" || grep -Fq 'run: sleep infinity' "$WORKFLOW"; then
  fail 'Session runtime must replace the ready callback and passive keep-alive'
fi
claim_line="$(grep -nF 'uses: ./.github/actions/environment-control' "$WORKFLOW" | cut -d: -f1)"
secret_line="$(grep -nF 'MINI_END_USER_KEY: ${{ secrets.MINI_END_USER_KEY }}' "$WORKFLOW" | cut -d: -f1)"
network_line="$(grep -nF 'uses: tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8' "$WORKFLOW" | cut -d: -f1)"
network_optional_line="$(grep -nF 'continue-on-error: true' "$WORKFLOW" | cut -d: -f1)"
t3_line="$(grep -nF 'uses: ./.github/actions/t3-session' "$WORKFLOW" | cut -d: -f1)"
(( claim_line < secret_line && claim_line < network_line && claim_line < t3_line )) || \
  fail 'runner claim must precede credentials, private network, and T3 setup'
(( network_optional_line < network_line && network_line < t3_line )) || \
  fail 'only the pre-T3 private-network step may be best effort'
grep -Fq 'id-token: write' "$WORKFLOW" || \
  fail 'private environment must request OIDC identity for its callback'
runtime_line="$(grep -nF 'uses: ./.github/actions/session-runtime' "$WORKFLOW" | cut -d: -f1)"
(( t3_line < runtime_line )) || \
  fail 'Session runtime must start after T3 publishes its private descriptor'
if rg -q 'TARGET_REPO|TARGET_REPO_AUTH|enable_ssh|non_durable|target-workspace' \
  "$WORKFLOW" "$T3_ACTION"; then
  fail 'private environment still contains repository or optional-lifecycle inputs'
fi
grep -Fq 'install -d -m 0700 "$HOME/workspace"' "$T3_ACTION" || \
  fail 'private environment must create the empty user workspace'
grep -Fq '"$HOME/workspace"' "$T3_ACTION" || \
  fail 'T3 must open the empty user workspace'
[[ "$(grep -Fc 'uses: ./.github/actions/await-log' "$T3_ACTION")" == 1 ]] || \
  fail 'T3 session must only wait for the Quick Tunnel URL'
grep -Fq 'npx --yes t3@latest auth pairing create' "$T3_ACTION" || \
  fail 'T3 session must use the native CLI to issue the public pairing URL'
grep -Fq -- '--base-url "$backend_url"' "$T3_ACTION" || \
  fail 'T3 pairing URL must use the ready Quick Tunnel as its base URL'
grep -Fq -- '--json | jq -er .pairUrl' "$T3_ACTION" || \
  fail 'T3 session must consume the native pairUrl JSON field'

grep -Fq 'using: node24' "$ENVIRONMENT_ACTION" || \
  fail 'Environment callback must use the current Node 24 Action runtime'
grep -Fq 'ACTIONS_ID_TOKEN_REQUEST_URL' "$ENVIRONMENT_SCRIPT" || \
  fail 'Environment callback must obtain a GitHub OIDC token'
grep -Fq 'using: node24' "$SESSION_RUNTIME_ACTION" || \
  fail 'Session runtime must use the current Node 24 Action runtime'
grep -Fq 'ACTIONS_ID_TOKEN_REQUEST_URL' "$SESSION_RUNTIME_SCRIPT" || \
  fail 'Session runtime must obtain a fresh GitHub OIDC token'
grep -Fq '::add-mask::${pairingUrl}' "$SESSION_RUNTIME_SCRIPT" || \
  fail 'Session runtime must mask native T3 pairing access'
grep -Fq 'new WebSocket(' "$SESSION_RUNTIME_SCRIPT" || \
  fail 'Session runtime must initiate its outbound control channel'
if rg -q 'tailscaleHost' "$SESSION_RUNTIME_SCRIPT" "$ROOT_DIR/apps/chatgpt-app/src"; then
  fail 'optional Tailscale identity must not enter the Environment ready descriptor'
fi
if rg -q 'LARK_APP_|LARK_CHAT_|lark-send' "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'mandatory Lark delivery must not remain in the Environment path'
fi

grep -Fq 'https://x.ai/cli/install.sh' "$TOOLS_ACTION" || \
  fail 'private session must use the official Grok Build installer'

# Codex and Grok share one scoped Mini key. Provider endpoints remain GitHub
# Secrets, and each CLI resolves that key through its native user config.
for file in "$WORKFLOW" "$CODEX_AUTH_WORKFLOW" "$GROK_AUTH_WORKFLOW"; do
  if rg -q 'CODEX_API_KEY|CODEX_RESPONSES_API_ENDPOINT|XAI_API_KEY' "$file"; then
    fail "workflow still uses a superseded executor credential: $file"
  fi
done

for auth_workflow in "$CODEX_AUTH_WORKFLOW" "$GROK_AUTH_WORKFLOW"; do
  grep -Fq 'workflow_dispatch:' "$auth_workflow" || \
    fail "auth workflow must support manual dispatch: $auth_workflow"
  grep -Fq 'schedule:' "$auth_workflow" || \
    fail "auth workflow must run daily: $auth_workflow"
  grep -Fq 'permissions:' "$auth_workflow" || \
    fail "auth workflow must declare permissions: $auth_workflow"
  grep -Fq 'contents: read' "$auth_workflow" || \
    fail "auth workflow permissions must be read-only: $auth_workflow"
  grep -Fq 'secrets.MINI_END_USER_KEY' "$auth_workflow" || \
    fail "auth workflow must use the shared Mini key: $auth_workflow"
  grep -Fq '> /dev/null' "$auth_workflow" || \
    fail "auth workflow must discard the model output: $auth_workflow"
  if rg -q '^  (push|pull_request|pull_request_target):' "$auth_workflow"; then
    fail "auth workflow must not run for source changes: $auth_workflow"
  fi
done
grep -Fq 'secrets.MINI_CODEX_BASE_URL' "$CODEX_AUTH_WORKFLOW" || \
  fail 'Codex auth workflow must use the secret endpoint'
grep -Fq 'https://chatgpt.com/codex/install.sh' "$CODEX_AUTH_WORKFLOW" || \
  fail 'Codex auth workflow must use the official current installer'
grep -Fq 'env_key = "MINI_END_USER_KEY"' "$CODEX_AUTH_WORKFLOW" || \
  fail 'Codex auth workflow must use native environment-key configuration'
grep -Fq 'codex exec --ephemeral --skip-git-repo-check --sandbox read-only' "$CODEX_AUTH_WORKFLOW" || \
  fail 'Codex auth workflow must verify the real CLI execution path'
grep -Fq 'secrets.MINI_GROK_BASE_URL' "$GROK_AUTH_WORKFLOW" || \
  fail 'Grok auth workflow must use the secret endpoint'
grep -Fq 'https://x.ai/cli/install.sh' "$GROK_AUTH_WORKFLOW" || \
  fail 'Grok auth workflow must use the official current installer'
grep -Fq 'env_key = "MINI_END_USER_KEY"' "$GROK_AUTH_WORKFLOW" || \
  fail 'Grok auth workflow must use native environment-key configuration'
grep -Fq 'grok --no-auto-update --always-approve -m mini-grok-4-6' "$GROK_AUTH_WORKFLOW" || \
  fail 'Grok auth workflow must verify the real CLI execution path'

if rg -q 'experimental_bearer_token|auth[.]json|api_key\s*=' \
  "$WORKFLOW" "$CODEX_AUTH_WORKFLOW" "$GROK_AUTH_WORKFLOW"; then
  fail 'workflow must not persist executor credentials or use login-session files'
fi

grep -Fq 'securitySchemes: SECURITY_SCHEMES' "$ROOT_DIR/apps/chatgpt-app/src/mcp.js" || \
  fail 'MCP tools must advertise their OAuth security schemes'

if rg -q 'report-lark[.]py|LARK_WEBHOOK_' "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'workflow still uses the legacy Lark Webhook reporter'
fi

# Pairing material stays in private session files and is masked if echoed.
grep -Eq 't3code/pairing-url|SESSION_DIR/t3code/pairing-url' "$T3_ACTION" || \
  fail 'missing private pairing-url file write'
grep -Fq '::add-mask::' "$ROOT_DIR/.github/actions/await-log/index.js" || \
  fail 'missing Actions masking for pairing material'

if grep -Fq 'sleep 3' "$T3_ACTION"; then
  fail 'service readiness must not depend on a fixed sleep'
fi

# The environment is intentionally direct and declarative: no cache/bootstrap
# script should hide tool installation or pin a second toolchain.
if rg -q 'setup-development-environment|development-versions|runner-bootstrap|prepare-development-cache' \
  "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'workflow still delegates development environment setup to legacy scripts'
fi

grep -Fq 'https://chatgpt.com/codex/install.sh' "$TOOLS_ACTION" || \
  fail 'missing official Codex installer'
if rg -qi 'claude|anthropic' "$WORKFLOW" "$TOOLS_ACTION"; then
  fail 'workflows and actions must expose only Codex and Grok executors'
fi
grep -Fq 'npx --yes t3@latest serve' "$T3_ACTION" || \
  fail 'missing latest T3 Code entrypoint'
grep -Fq -- '--ttl 6h' "$T3_ACTION" || \
  fail 'T3 pairing credential must remain valid for the GitHub-hosted session lifetime'
grep -Fq 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64' "$T3_ACTION" || \
  fail 'T3 session must download the latest official cloudflared binary'
if rg -q 'openssh-server|sshd_config|ssh-public-key|ssh_public_key' \
  "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'OpenSSH fallback must not return'
fi

if grep -Fq "pattern: '^Pairing URL:" "$T3_ACTION"; then
  fail 'T3 session must not reuse the loopback pairing URL from serve output'
fi

# Public repository: never publish pairing material, private repo names, or
# token-bearing service logs through Actions-visible channels. Pairing access
# belongs only in the authenticated Environment entry.
if rg -q 'GITHUB_STEP_SUMMARY' "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'workflow writes GitHub step summary (public on public repos)'
fi

if rg -q 'echo "\$t3_link"|echo "\$pairing_|echo "\$client_pair|echo "T3 Code link:' \
  "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'workflow prints T3 pairing material to Actions output'
fi

if rg -q 'cat "\$t3_log"|cat "\$tunnel_log"' "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'workflow dumps service logs that can contain pairing tokens'
fi

printf '%s\n' 'workflow security contract tests passed'
