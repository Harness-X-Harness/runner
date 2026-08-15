# ChatGPT app acceptance memory

This document records the changing acceptance state for the ChatGPT code-task
control plane. Stable, cross-cutting facts belong in
[project memory](../project-memory.md). It is not an execution log. Secret
values, private keys, OAuth tokens, prompts, and raw API responses must not be
copied here.

Evidence below was refreshed on 2026-08-15 unless a narrower boundary is
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
| Production deployment and health | **Passed** | On 2026-08-15, branded Worker version `564d8af1-a25a-4b2f-b03b-2b0dd989c6d4` deployed with `GITHUB_RUNNER_REPOSITORY=Harness-X-Harness/runner`; `/health` returned exact body `ok`, unauthenticated `/mcp` returned `401`, and the runner repository `TASK_CONTROL_PLANE_URL` variable exactly matched the Worker origin. The App also created a repository-scoped installation token with `Actions: write`, and that token read the active `execute-task.yml`. No workflow was dispatched by this deployment check. |
| Deployed OAuth authorization and MCP authentication | **Passed** | A public PKCE client completed interactive GitHub authorization, Worker callback, OAuth grant persistence, authorization-code token exchange, refresh-token issuance, and authenticated MCP `initialize`. The validation recorded only boolean/result summaries and did not print or persist codes or tokens. The original failure was a 403 HTML response from GitHub `GET /user` without the required `User-Agent`, followed by an unhandled JSON parse exception; the deployed fix validates the profile response, uses the delimiter-safe `github-<id>` subject, and applies unified GitHub REST headers. |
| MCP task dispatch and runner checkout | **Passed** | `submit_task` created `task_b680badb-4a1d-42bd-97e7-4f20b19626d5`; production run `30196554687` dispatched from `main`, resolved the target installation, created a token, and checked out the target repository. |
| Runner callback and Codex analyze execution | **Passed** | After correcting the action input mapping, production task `task_80dcbfdc-0a6c-4068-8dc1-e38e8f96bf9e` completed in run `30196918275`. `Report running`, private prompt fetch, Codex, testing, no-change detection, `Report completed`, and result publication all succeeded. Analyze mode created no branch, commit, or pull request. |
| Authenticated public result retrieval | **Passed with user-side MCP evidence** | On 2026-08-15, after creating and authorizing the branded ChatGPT MCP connection, the owning user confirmed that `get_task_result` returned task `task_80dcbfdc-0a6c-4068-8dc1-e38e8f96bf9e` as `completed`, including run `30196918275` and the expected no-change summary. Its repository field is a historical pre-migration task snapshot, not the current dispatch configuration. The access token and private Durable Object fields are not available to this repository-side validation session. |
| Branded Worker cutover | **Passed** | The Cloudflare scripts API listed `harness-x-harness-task-runner-control-plane`; its `/health` returned `ok` and unauthenticated `/mcp` returned `401`. After the authenticated ChatGPT tool call passed, the legacy Worker was deleted. Its former `/health` endpoint then returned `404`, while the branded Worker remained healthy. |
| Cancellation without a run ID | **User-confirmed; repository-side evidence is partial** | The failed initial task is the only non-completed task that could have been cancelled. Its callback failed before saving a run ID, so cancelling it exercises the direct `cancelled` branch rather than GitHub workflow cancellation. |
| Cancellation with a run ID and late callback convergence | **Passed** | Production task `task_efdc53a0-2ac1-46f6-8d5d-e39ea0c1e043` first completed `Report running` and private prompt fetch, then `cancel_task` cancelled GitHub run `30234427808` while Codex was running. The workflow concluded `cancelled`, `Report cancelled` succeeded, and the owning user's subsequent MCP/DO query returned terminal status `cancelled`. Code-level lifecycle tests additionally verify that a later non-cancelled callback cannot revive a cancellation-requested task. |

The branded production Worker, end-to-end analyze path, authenticated public
result read, and running-workflow cancellation lifecycle are externally
validated. The historical task read proves the post-cutover ChatGPT connection;
it does not re-run dispatch against the renamed repository.
