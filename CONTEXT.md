# Harness X Harness

Harness X Harness provides one temporary private development Environment and
interactive Agent Sessions for each authorized GitHub user.

## Language

**Harness Principal**:
One person identified by a stable GitHub numeric user ID. The same person is
one Principal across ChatGPT, VS Code, and other MCP clients.
_Avoid_: MCP User, ChatGPT User, Client Account

**MCP Client**:
One software interface that connects to Harness and holds its own authorization
grant. It does not own Environments or Sessions.
_Avoid_: Harness Principal, User

**MCP Grant**:
One revocable permission relationship between an MCP Client and a Harness
Principal. Grants remain separate when several clients belong to one Principal.
_Avoid_: User Account, GitHub Authorization

**Execution Repository**:
The trusted GitHub repository whose workflow allocates and operates temporary
Environment runners.
_Avoid_: Workspace, user project repository

**Execution Authorization**:
GitHub's decision that a Harness Principal may dispatch, observe, or cancel a
workflow in the Execution Repository. Harness presents a GitHub App user token
scoped to that repository and `Actions: write`; the Principal remains the
GitHub actor.
_Avoid_: Organization Membership, installation token, App dispatch

**Agent GitHub Authorization**:
GitHub authorization that the user establishes inside one admitted Environment
for `gh`, Git, or GitHub MCP. Harness transports interactive prompts but does
not issue, store, refresh, or inject this credential. It ends with the
Environment.
_Avoid_: Execution Authorization, MCP Grant

**Executor Provider Credential**:
One platform-managed credential and private provider configuration shared with
trusted organization users so Codex and Grok work immediately. Other processes
owned by the Environment user can read it.
_Avoid_: Agent GitHub Authorization, Execution Authorization, per-user secret

**Agent Session**:
One user-delegated, multi-turn Codex or Grok conversation that retains native
agent context until it stops or the runner ends. Parallel Sessions can use the
same user-managed working directory; native session records do not isolate
filesystem state.
_Avoid_: T3 Thread, fixed pipeline, workflow run

**Session Controller**:
The one MCP Grant allowed to send turns and answer requests for an Agent
Session. The owning Principal can explicitly transfer control to another Grant.
_Avoid_: Session Owner, MCP Client, lease

**Session Event**:
One private, ordered user-visible Agent output, lifecycle change, request, or
error. Its cursor supports reconnect inside the same Environment generation.
_Avoid_: Workflow Log, raw transcript, MCP Notification

**Environment Control Channel**:
The single outbound WebSocket from one admitted Environment Run to its owner's
`EnvironmentObject`. It multiplexes commands and Session Events for that
generation.
_Avoid_: T3 Interface, Tailscale, MCP connection

**Remote Development Environment**:
One user-owned GitHub-hosted runner for exactly one workflow run. It can contain
zero or many repositories and can be reached through several remote clients.
All files, processes, native Sessions, and transient credentials disappear when
the run ends.
_Avoid_: persistent machine, repository workflow

**Environment Run**:
The GitHub Actions workflow run that creates and terminates one Environment.
GitHub status is lifecycle authority. The control plane stores only owner,
generation, exact run, private delivery, and close intent.
_Avoid_: Agent Session, control-plane lifecycle authority

**Environment Admission**:
The OIDC-authenticated claim that binds one exact GitHub run to the current user
generation before executor credentials, Tailscale, or T3 start. A closed or old
generation fails this gate.
_Avoid_: dispatch response, ready callback

**Connection Descriptor**:
Private connection data for one active Environment, such as its Tailscale host
and T3 pairing entry. It exists only in owner-scoped state and the runner.
_Avoid_: stable tunnel, MCP result, artifact

**T3 Interface**:
An optional remote code-editor interface inside the Environment. T3 owns its
projects, Threads, approvals, diffs, and terminals; it does not own Environment
or Agent Session lifecycle.
_Avoid_: Environment control plane, MCP transport

**Private Network Interface**:
The Tailscale/Headscale connection to the Environment. It provides Tailscale
SSH and can support another verified remote client.
_Avoid_: T3 Tunnel, proof of client compatibility

**Environment Entry**:
The stable authenticated browser route that shows Preparing, redirects the
owner to T3 pairing when ready, and becomes Offline after the exact GitHub run
terminates.
_Avoid_: Stable Tunnel, pairing-token MCP result, lifecycle authority
