#!/usr/bin/env bash
# Contract checks for public-repo safety and the one-shot Lark connection card.
# These are policy assertions over workflow YAML, not behavioral tests.
# Implementation details (installer URLs, package versions) belong elsewhere.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/private-runner-session.yml"
TASK_WORKFLOW="$ROOT_DIR/.github/workflows/execute-task.yml"
CODEX_AUTH_WORKFLOW="$ROOT_DIR/.github/workflows/codex-auth.yml"
GROK_AUTH_WORKFLOW="$ROOT_DIR/.github/workflows/grok-auth.yml"
TOOLS_ACTION="$ROOT_DIR/.github/actions/development-tools/action.yml"
NETWORK_ACTION="$ROOT_DIR/.github/actions/private-network/action.yml"
T3_ACTION="$ROOT_DIR/.github/actions/t3-session/action.yml"
AWAIT_ACTION="$ROOT_DIR/.github/actions/await-log/action.yml"
LARK_ACTION="$ROOT_DIR/.github/actions/lark-send/action.yml"
LARK_SCRIPT="$ROOT_DIR/.github/actions/lark-send/index.js"
CONTROL_ACTION="$ROOT_DIR/.github/actions/task-control/action.yml"
CONTROL_SCRIPT="$ROOT_DIR/.github/actions/task-control/index.js"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$WORKFLOW" ]] || fail "missing workflow: $WORKFLOW"
[[ -f "$TASK_WORKFLOW" ]] || fail "missing workflow: $TASK_WORKFLOW"
[[ -f "$CODEX_AUTH_WORKFLOW" ]] || fail "missing workflow: $CODEX_AUTH_WORKFLOW"
[[ -f "$GROK_AUTH_WORKFLOW" ]] || fail "missing workflow: $GROK_AUTH_WORKFLOW"
for action in "$TOOLS_ACTION" "$NETWORK_ACTION" "$T3_ACTION" "$AWAIT_ACTION" "$LARK_ACTION" "$CONTROL_ACTION"; do
  [[ -f "$action" ]] || fail "missing composite action: $action"
done

# GitHub Actions is the complete environment lifecycle. The workflow has one
# fixed profile, no dispatch parameters, and sends one ready connection card.
grep -Fq 'workflow_dispatch:' "$WORKFLOW" || \
  fail 'private environment must use manual workflow dispatch'
if rg -q '^    inputs:|inputs[.]' "$WORKFLOW"; then
  fail 'private environment workflow must have zero inputs'
fi
grep -Fq 'environment: session--none' "$WORKFLOW" || \
  fail 'private environment must use the fixed session--none profile'
grep -Fq 'uses: ./.github/actions/private-network' "$WORKFLOW" || \
  fail 'private environment must always join the private network'
grep -Fq 'uses: ./.github/actions/t3-session' "$WORKFLOW" || \
  fail 'private environment must always start T3'
[[ "$(grep -Fc 'uses: ./.github/actions/lark-send' "$WORKFLOW")" == 1 ]] || \
  fail 'private environment must send exactly one Lark connection card'
grep -Fq 'run: sleep infinity' "$WORKFLOW" || \
  fail 'private environment must remain until cancellation or platform limit'
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

grep -Fq 'using: node24' "$LARK_ACTION" || \
  fail 'LarkSend must use the current Node 24 Action runtime'
if grep -Fq 'post:' "$LARK_ACTION"; then
  fail 'LarkSend must not define a post cleanup hook'
fi
grep -Fq 'Authorization: `Bearer ${accessToken}`' "$LARK_SCRIPT" || \
  fail 'Lark card requests must use the application access token'
[[ "$(grep -Fc 'method: "POST"' "$LARK_SCRIPT")" == 2 ]] || \
  fail 'LarkSend must only request a token and create one message'
if rg -q 'method: "PATCH"|message_id|GITHUB_STATE|Offline|Starting' "$LARK_ACTION" "$LARK_SCRIPT"; then
  fail 'LarkSend still contains lifecycle update state'
fi
grep -Fq '"pairing-url"' "$LARK_SCRIPT" || \
  fail 'LarkSend must read the native T3 pairing URL'
grep -Fq 'enable_forward: false' "$LARK_SCRIPT" || \
  fail 'Lark connection card containing pairing access must not be forwardable'
grep -Fq 'secrets.LARK_APP_ID' "$WORKFLOW" || \
  fail 'workflow must pass LARK_APP_ID'
grep -Fq 'secrets.LARK_APP_SECRET' "$WORKFLOW" || \
  fail 'workflow must pass LARK_APP_SECRET'
grep -Fq 'secrets.LARK_CHAT_NAME' "$WORKFLOW" || \
  fail 'workflow must pass LARK_CHAT_NAME'

# The control-plane workflow receives task metadata only. The private prompt is
# fetched through a GitHub OIDC-authenticated callback after the runner starts.
for input in task_id repo ref executor mode; do
  grep -Fq "      $input:" "$TASK_WORKFLOW" || \
    fail "task workflow missing input: $input"
done
if grep -Fq '      prompt:' "$TASK_WORKFLOW"; then
  fail 'task workflow must not accept the private prompt as dispatch input'
fi
grep -Fq 'id-token: write' "$TASK_WORKFLOW" || \
  fail 'task workflow must request OIDC identity for callbacks'
grep -Fq 'uses: ./.github/actions/task-control' "$TASK_WORKFLOW" || \
  fail 'task workflow must use the OIDC task-control action'
grep -Fq 'status: task.status' "$ROOT_DIR/apps/chatgpt-app/src/index.js" || \
  fail 'runner prompt fetch must expose cancellation status'
grep -Fq 'summary="$(< "$RUNNER_TEMP/executor.result")"' "$TASK_WORKFLOW" || \
  fail 'task callback must publish the native driver result'
grep -Fq 'ACTIONS_ID_TOKEN_REQUEST_URL' "$CONTROL_SCRIPT" || \
  fail 'task-control action must obtain a GitHub OIDC token'
grep -Fq '::add-mask::' "$CONTROL_SCRIPT" || \
  fail 'task-control action must mask its callback token'
if grep -Fq 'GITHUB_APP_PRIVATE_KEY: ${{ secrets.RUNNER_GITHUB_APP_PRIVATE_KEY }}' "$TASK_WORKFLOW"; then
  fail 'GitHub App private key must not be job-wide executor environment'
fi
grep -Fq 'app-id: ${{ secrets.RUNNER_GITHUB_APP_ID }}' "$TASK_WORKFLOW" || \
  fail 'task workflow must use a configurable GitHub App ID secret'
grep -Fq 'private-key: ${{ secrets.RUNNER_GITHUB_APP_PRIVATE_KEY }}' "$TASK_WORKFLOW" || \
  fail 'task workflow must use a configurable GitHub App private-key secret'
if rg -q 'secrets[.]GITHUB_' "$TASK_WORKFLOW"; then
  fail 'custom Actions secrets cannot use the reserved GITHUB_ prefix'
fi
grep -Fq 'https://x.ai/cli/install.sh' "$TASK_WORKFLOW" || \
  fail 'task workflow must use the official Grok Build installer'
grep -Fq 'https://x.ai/cli/install.sh' "$TOOLS_ACTION" || \
  fail 'private session must use the official Grok Build installer'
grep -Fq 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1' "$TASK_WORKFLOW" || \
  fail 'task workflow must use a SHA-pinned GitHub App token action'
grep -Fq '      repository_access:' "$TASK_WORKFLOW" || \
  fail 'task workflow must receive the verified repository access path'
grep -Fq "inputs.repository_access == 'installation'" "$TASK_WORKFLOW" || \
  fail 'target installation token must be conditional'
grep -Fq 'name: Check out public target repository' "$TASK_WORKFLOW" || \
  fail 'public analyze must have one installation-free checkout path'
grep -Fq "inputs.repository_access == 'public_read' && inputs.mode != 'analyze'" "$TASK_WORKFLOW" || \
  fail 'public read must never authorize a write mode'
if grep -Fq 'continue-on-error:' "$TASK_WORKFLOW"; then
  fail 'repository access must not fall back after a failed step'
fi

# Codex and Grok share one scoped Mini key. Provider endpoints remain GitHub
# Secrets, and each CLI resolves that key through its native user config.
for file in "$WORKFLOW" "$TASK_WORKFLOW" "$CODEX_AUTH_WORKFLOW" "$GROK_AUTH_WORKFLOW"; do
  if rg -q 'CODEX_API_KEY|CODEX_RESPONSES_API_ENDPOINT|XAI_API_KEY' "$file"; then
    fail "workflow still uses a superseded executor credential: $file"
  fi
done
grep -Fq 'secrets.MINI_END_USER_KEY' "$TASK_WORKFLOW" || \
  fail 'task workflow must use the shared Mini end-user key'
grep -Fq 'secrets.MINI_CODEX_BASE_URL' "$TASK_WORKFLOW" || \
  fail 'Codex endpoint must come from its GitHub Secret'
grep -Fq 'secrets.MINI_GROK_BASE_URL' "$TASK_WORKFLOW" || \
  fail 'Grok endpoint must come from its GitHub Secret'
grep -Fq 'env_key = "MINI_END_USER_KEY"' "$TASK_WORKFLOW" || \
  fail 'Grok native config must resolve the shared key from the environment'
grep -Fq '[model.mini-grok-4-6]' "$TASK_WORKFLOW" || \
  fail 'Grok native config must select the Mini Grok model'
grep -Fq 'https://chatgpt.com/codex/install.sh' "$TASK_WORKFLOW" || \
  fail 'task workflow must use the official Codex CLI installer'
grep -Fq 'codex exec --ephemeral --sandbox workspace-write --output-last-message "$RUNNER_TEMP/executor.result" - < "$RUNNER_TEMP/task.prompt" > /dev/null 2>&1' "$TASK_WORKFLOW" || \
  fail 'Codex driver must keep its native transcript out of the log'
grep -Fq 'grok --no-auto-update --always-approve -m mini-grok-4-6 --output-format json --prompt-file "$RUNNER_TEMP/task.prompt" | jq -r .text > "$RUNNER_TEMP/executor.result"' "$TASK_WORKFLOW" || \
  fail 'Grok driver must extract the native final response'
if grep -Fq 'openai/codex-action' "$TASK_WORKFLOW"; then
  fail 'task workflow must use the native Codex CLI, not the Codex Action'
fi

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
  "$WORKFLOW" "$TASK_WORKFLOW" "$CODEX_AUTH_WORKFLOW" "$GROK_AUTH_WORKFLOW"; then
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
grep -Fq 'https://claude.ai/install.sh' "$TOOLS_ACTION" || \
  fail 'missing official Claude Code installer'
grep -Fq 'npx --yes t3@latest serve' "$T3_ACTION" || \
  fail 'missing latest T3 Code entrypoint'
grep -Fq 'https://pkg.cloudflare.com/cloudflared noble main' "$T3_ACTION" || \
  fail 'missing official cloudflared package repository'
grep -Fq 'apt-get install -y -qq cloudflared' "$T3_ACTION" || \
  fail 'missing cloudflared package install'
grep -Fq -- '--ssh' "$NETWORK_ACTION" || \
  fail 'private network must enable Tailscale SSH'

if rg -q 'openssh-server|sshd_config|ssh-public-key|ssh_public_key' \
  "$WORKFLOW" "$ROOT_DIR/.github/actions"; then
  fail 'OpenSSH fallback must not return'
fi

if grep -Fq "pattern: '^Pairing URL:" "$T3_ACTION"; then
  fail 'T3 session must not reuse the loopback pairing URL from serve output'
fi

# Public repository: never publish pairing material, private repo names, or
# token-bearing service logs through Actions-visible channels. Pairing access
# belongs only in the configured non-forwardable Lark card.
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
