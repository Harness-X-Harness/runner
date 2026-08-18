# Use Principal OAuth authority for workflow control

Status: accepted for Remote Development Environments and Agent Sessions.

Harness uses a GitHub App to identify each Harness Principal. After GitHub
issues a user access token, Harness derives a second token limited to
`Harness-X-Harness/runner` and `Actions: write`. Only this scoped user token
dispatches, observes, and cancels the exact Environment workflow run. GitHub
therefore evaluates repository access, Actions policy, and workflow protections
with the real Principal as actor.

OAuth completion identifies the Principal but does not separately prove organization membership or preflight repository permission. The first real `workflow_dispatch` is the Execution Authorization gate. Harness does not request `read:org` or maintain a second membership view that can become stale before dispatch.

GitHub App user authorization does not request the traditional OAuth `repo`
scope. Harness uses GitHub's scoped user-token exchange to enforce the exact
repository and permission capability boundary. The base user access token is
not retained.

The Environment command path does not create or use a GitHub App installation
token, App JWT, installation ID, repository-installation continuation, base
user token, or platform credential fallback. If the user revokes authorization or loses
access to the Execution Repository, Harness stops acting for that user. An
already admitted run continues until the user cancels it in GitHub, the run
exits, or the platform time limit terminates it.

The dispatch credential remains encrypted in the control plane and never enters the Environment, MCP output, Widget, Session Event, workflow input, log, or artifact. A user authorizes `gh`, Git, or GitHub MCP independently inside the admitted Environment.

This chooses one user-owned workflow authority and the shortest correct happy path. It accepts loss of automatic cleanup after user authorization is revoked instead of maintaining a second platform authority.

A possible organization-owned scavenger is a separate future decision. It must not become an implicit fallback in the user command path or a reason to delay the OAuth-only workflow lifecycle.
