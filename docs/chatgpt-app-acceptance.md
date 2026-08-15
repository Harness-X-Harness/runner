# ChatGPT app acceptance memory

This document records the changing acceptance state for the ChatGPT code-task
control plane. Stable, cross-cutting facts belong in
[project memory](../project-memory.md). It is not an execution log. Secret
values, private keys, OAuth tokens, prompts, and raw API responses must not be
copied here.

Evidence below was refreshed on 2026-07-26 unless a narrower boundary is
stated.

## Current acceptance state

| Gate | State | Evidence and boundary |
| --- | --- | --- |
| Worker typecheck | **Passed** | `npm --prefix apps/chatgpt-app run typecheck` completed successfully. |
| Workflow security contract | **Passed** | `bash tests/workflow-security.test.sh` completed successfully. |
| Complete local Node test suite | **Passed** | `node --test tests/*.test.js`: 33 passed and 0 failed. |
| Installation auto-resolution behavior | **Passed in code-level test** | The production-edge test observes repository installation lookup followed by installation-token creation and workflow dispatch. Deployment configuration contains no manual installation ID. |
| GitHub App installation | **Passed** | On 2026-08-15, an App JWT identified `Harness-X-Harness` as the App owner and authenticated `GET /repos/Harness-X-Harness/runner/installation`. The active organization installation covers all repositories and reports `Actions`, `Contents`, and `Pull requests: write` plus `Metadata: read`. The ID and JWT were not printed or persisted. |
| Runner GitHub App credentials | **Passed** | Production run `30196554687` created a target-repository installation token and checked out the runner repository successfully. The workflow uses `RUNNER_GITHUB_APP_ID` and `RUNNER_GITHUB_APP_PRIVATE_KEY` because GitHub rejects custom secret names beginning with `GITHUB_`; no credential value was recorded. |
| Codex executor credentials | **Passed** | `CODEX_API_KEY` and `CODEX_RESPONSES_API_ENDPOINT` are configured as runner repository secrets, and production run `30196918275` exercised the pinned Codex Action successfully without printing their values. |
| Cloudflare API credentials | **Passed for the current deployment boundary** | The ignored `.secrets.env` contains one account-owned `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`. Token verification, account read, Workers script listing, and KV namespace listing all returned HTTP 200 without printing credential values. Creating the production OAuth KV namespace proved the required KV write permission. |
| Staging deployment and health | **Passed** | On 2026-08-15, Worker version `f31ba9b8-6664-403a-8b94-21ee354e6692` deployed with `GITHUB_RUNNER_REPOSITORY=Harness-X-Harness/runner`; `/health` returned exact body `ok`. The App created a repository-scoped installation token with `Actions: write`, and that token read the active `execute-task.yml`. No workflow was dispatched by this check. The runner repository `TASK_CONTROL_PLANE_URL` variable exactly matches the Worker origin. |
| Deployed OAuth authorization and MCP authentication | **Passed** | A public PKCE client completed interactive GitHub authorization, Worker callback, OAuth grant persistence, authorization-code token exchange, refresh-token issuance, and authenticated MCP `initialize`. The validation recorded only boolean/result summaries and did not print or persist codes or tokens. The original failure was a 403 HTML response from GitHub `GET /user` without the required `User-Agent`, followed by an unhandled JSON parse exception; the deployed fix validates the profile response, uses the delimiter-safe `github-<id>` subject, and applies unified GitHub REST headers. |
| MCP task dispatch and runner checkout | **Passed** | `submit_task` created `task_b680badb-4a1d-42bd-97e7-4f20b19626d5`; production run `30196554687` dispatched from `main`, resolved the target installation, created a token, and checked out the target repository. |
| Runner callback and Codex analyze execution | **Passed** | After correcting the action input mapping, production task `task_80dcbfdc-0a6c-4068-8dc1-e38e8f96bf9e` completed in run `30196918275`. `Report running`, private prompt fetch, Codex, testing, no-change detection, `Report completed`, and result publication all succeeded. Analyze mode created no branch, commit, or pull request. |
| Authenticated public result retrieval | **Passed with user-side MCP evidence** | The owning user confirmed that `get_task_result` returned the completed task's public result through the authorized ChatGPT MCP connection. The access token and private Durable Object fields are not available to this repository-side validation session. |
| Cancellation without a run ID | **User-confirmed; repository-side evidence is partial** | The failed initial task is the only non-completed task that could have been cancelled. Its callback failed before saving a run ID, so cancelling it exercises the direct `cancelled` branch rather than GitHub workflow cancellation. |
| Cancellation with a run ID and late callback convergence | **Passed** | Production task `task_efdc53a0-2ac1-46f6-8d5d-e39ea0c1e043` first completed `Report running` and private prompt fetch, then `cancel_task` cancelled GitHub run `30234427808` while Codex was running. The workflow concluded `cancelled`, `Report cancelled` succeeded, and the owning user's subsequent MCP/DO query returned terminal status `cancelled`. Code-level lifecycle tests additionally verify that a later non-cancelled callback cannot revive a cancellation-requested task. |

The staging Worker, end-to-end analyze path, authenticated public result read,
and running-workflow cancellation lifecycle are externally validated.
