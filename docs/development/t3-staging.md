# Isolated T3 staging acceptance

Keep PR #229 Draft. Production deployment, merge, production OAuth changes and
existing Runner jobs are outside this procedure. The original
[G0–G5 definitions](../t3.md) remain authoritative. An offline config, fixture
test, idle native thread or headless approval cannot complete a deployed or
human-user gate.

## Isolation prerequisites

Provision and verify all of these before any staging deployment or dispatch:

| Boundary | Required independent staging resource and evidence |
| --- | --- |
| Cloudflare authority | Operator access to the intended account: Workers scripts/deployment/settings, new KV namespace, SQLite Durable Objects/migrations, Containers image registry/build and deployment, and the selected custom domain/zone. Confirm account/plan supports Containers and has quota. A dedicated staging account is preferable; account access alone is not proof of isolation. |
| Worker and routing | A new Worker name and HTTPS hostname with no production route. Confirm the name is unused before first deployment. No service bindings, cross-script DO bindings, production version promotion or production traffic splitting. |
| Storage and delivery | A newly created `OAUTH_KV` namespace and new Worker-local Authorization, Environment, Admission and EventDelivery DO namespaces. Fresh migrations create only the currently exported classes. Do not copy production KV IDs, grants, state, clients or DO migration history. Containers belong to the new Worker. |
| GitHub authorization | A separate GitHub App, client ID/secret, installation and webhook secret. Enable expiring user tokens and the repository permissions required by the [authorization contract](../chatgpt-app.md#oauth-and-github-app). Install only on the disposable execution repository. Callback must be exactly `<staging-origin>/github/callback`; webhook must be `<staging-origin>/github/events`, signed and subscribed to workflow run/job events. Never add a staging callback or webhook to the production App. |
| Execution repository | A separate disposable repository containing the trusted runtime and `run-environment.yml`; Actions enabled and workflow dispatch available on its default branch. A protected **branch** must point to the exact reviewed runtime revision. Set Worker `GITHUB_RUNNER_REPOSITORY` and `GITHUB_RUNNER_REF` to it. The OIDC verifier requires `ref_protected=true`, a GitHub-hosted runner, exact workflow/ref/repository, the staging origin as audience, and the owner's actor ID. A tag, SHA-only ref or unprotected feature branch will fail. Do not weaken these checks. |
| Runtime callbacks | Set `TASK_CONTROL_PLANE_URL` in the disposable repository to the staging origin. The Worker variable and repository variable must agree. Configure CI event coverage only for that repository. Do not change this variable in `Harness-X-Harness/runner`. |
| Work/provider credentials | Separate staging Agent GitHub authority restricted to a disposable workspace repository, plus separately authorized staging provider credentials/endpoints for Codex and Grok. Configure the execution repository's `AGENT_GITHUB_TOKEN`, `MINI_END_USER_KEY`, `MINI_CODEX_BASE_URL`, `MINI_GROK_BASE_URL`; never copy production secret values. No provider credentials are needed for the local idle-thread smoke. |
| Browser and client owners | A real authorized owner and a second GitHub identity for wrong-owner checks; an independent MCP client and reachable loopback callback/browser on the tester's machine. Obtain explicit approval for paid provider runs and disposable workspace mutations. |
| Cleanup authority | The owner must be able to observe and cancel exact staging workflow runs/attempts. Confirm webhook delivery plus owner-authorized reconciliation before testing closure. A webhook response, runtime disconnect or `closing` snapshot is insufficient stop evidence. |

GitHub repository administration does not provide Cloudflare account access,
GitHub App ownership, usable App secrets, a second identity or provider-run
approval. Repository Actions secrets cannot be read back to bootstrap staging.
If any prerequisite is missing, record it as blocked; never use the production
Worker, fixed Agent token or existing jobs as a shortcut.

## Offline preparation

From the repository root, with Node 24:

```sh
npm ci --prefix apps/chatgpt-app
npm ci --prefix .github/actions/agent-runtime
node tests/run-t3-staging-checks.ts
# Optional: official T3 0.1.5 already installed at an absolute path
node tests/run-t3-staging-checks.ts --native /absolute/path/to/t3
```

The wrapper uses a fresh HOME and an allowlist of child environment variables.
It discards ambient GitHub/Cloudflare/provider credentials, live origins, remote
tunnel and paid-model opt-ins. It runs local OAuth/state/lifecycle safety tests.
The optional native harness creates disposable state, uses loopback only,
exercises independent OAuth MCP and idle thread mutations, and verifies managed
process/listener cleanup. No staging/production API, GitHub dispatch or paid
inference is invoked. Install the official binary separately; its download
requires network access. The local tests use workerd and loopback listeners.

Create a private JSON manifest containing **only public identifiers**. Replace
every placeholder with a newly provisioned staging resource; do not put secrets
in the file:

```json
{
  "accountId": "<32 lowercase hex characters>",
  "workerName": "runner-staging-pr229",
  "origin": "https://<independent-staging-host>",
  "oauthKvId": "<new staging namespace: 32 lowercase hex characters>",
  "githubAppClientId": "<separate GitHub App client ID>",
  "executionRepository": "<owner>/<disposable-runner-repository>",
  "runtimeBranch": "staging/pr229",
  "runtimeRevision": "<exact reviewed 40-character Git commit>"
}
```

```sh
node tests/prepare-t3-staging.ts /private/path/staging-manifest.json > apps/chatgpt-app/wrangler.staging.generated.json
```

This command only reads the manifest and tracked production config, then emits
a standalone config with application logs disabled and fresh migrations. It
rejects production Worker/KV/App/repository/origin reuse, credential-bearing
URLs and unknown manifest keys. It cannot prove remote ownership, unused Worker
names, absence of pre-existing storage, branch protection, actual branch SHA,
App installation or secret availability. The `runtimeRevision` is an expected
revision for operator verification, not a SHA pin enforced by the Worker.
Verify the protected branch's actual SHA immediately before dispatch and record
the actual workflow checkout SHA afterward; prevent branch movement during the
acceptance window. Regenerate and re-review after any config/source change.

Keep the generated file beside `wrangler.jsonc` so source/build/Container paths
resolve correctly. Review it and compare it against the production config.
Any future Wrangler operation must explicitly select this standalone staging
config. **Do not run `npm run deploy`, `deploy.ts`, bare `wrangler deploy`, or
assume `--env staging` creates isolation**: the current wrapper selects the
production config and secrets. Provision staging-only secrets privately after
resource verification. Keep logs disabled until query redaction, invocation
logging and tracing settings have been verified against the new Worker only.

## Live acceptance after prerequisites

Use the same exact reviewed revision for the Worker and trusted runtime. Keep
private, redacted evidence with Runner SHA, T3 release, staging resource
identifiers, provider/model and per-gate outcomes. Never retain pairing URLs,
OAuth codes, cookies, tokens, full browser traces/HARs or raw model output.

1. **G1:** Discover the staging API through a new staging OAuth grant. Verify
   `open_environment` accepts `services:["t3"]`. Open one disposable Environment
   as the real owner; record its exact execution repository/run/attempt, actual
   checkout SHA, service readiness and local/public T3 identity/version match.
2. **G2:** In that Environment, explicitly authorize each provider run. Verify
   both T3-launched Codex and Grok nonce replies and authoritative completed
   native thread/run state. Local CLI inference is separate evidence.
3. **G3:** In a real browser, follow the Environment access URL through the
   separate GitHub App and native pairing. Exercise terminal, Git/worktree, diff
   and a native approval. Verify wrong-owner refusal, browser binding,
   single-use callback, fresh reauthentication and refusal after closure.
   Test pending pairing during failure, origin change and socket loss.
4. **G4:** From an independent external MCP SDK/client, use the G1 HTTPS origin,
   verify OAuth issuer/endpoints, register a client, perform S256 PKCE and
   **real browser approval**. Read projects. With an operate-scoped grant,
   create an idle thread (omit message/attachments), rename/read it and verify
   no run exists. Then, with separately authorized inference, send a nonce
   prompt, observe its exact run through `t3_thread_wait`/`t3_thread_read`,
   verify settled completion and mutation/provenance, archive the disposable
   thread and verify denial after session revocation. A read-only grant must
   deny a valid mutation; a network error is not permission-denial evidence.
   The local idle smoke covers creation/metadata mutation/read/idle-wait/archive
   only. It does not cover send, active-run observation, approval UX or G1.
5. **G5:** Use separate disposable Environments for explicit close and hard
   expiry. Complete an ordinary operation and hold T3 beyond the normal
   15-minute idle interval without starting another operation. Observe failure
   propagation for native server/tunnel exit and unavailable service on runtime
   disconnect. Close/expire each Environment, verify process/listener shutdown
   and loss of public access, then obtain confirmed Environment closure and
   matching terminal GitHub run/attempt/job evidence. Do not cancel unrelated
   runs. Local SQLite tests check intent versus exact-stop transitions and
   retained capacity; they do not prove remote job or process teardown.

Report failures, skips, missing configuration and human authorization blocks
separately. Keep the PR Draft until each required live gate has evidence; never
promote local checks or earlier-revision evidence to a current deployed pass.
