#!/usr/bin/env bash
# Static auth-workflow policy. Task behavior and private handoff are tested in task-workflow.test.js.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/run-task.yml"
CODEX_AUTH_WORKFLOW="$ROOT_DIR/.github/workflows/codex-auth.yml"
GROK_AUTH_WORKFLOW="$ROOT_DIR/.github/workflows/grok-auth.yml"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

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

# Public workflows must keep private results out of logs, summaries and artifacts.
if rg -q 'GITHUB_STEP_SUMMARY|actions/upload-artifact|set -x' \
  "$WORKFLOW" "$CODEX_AUTH_WORKFLOW" "$GROK_AUTH_WORKFLOW" "$ROOT_DIR/.github/actions/task-runtime"; then
  fail 'private Task data must not enter public diagnostic channels'
fi

printf '%s\n' 'workflow security contract tests passed'
