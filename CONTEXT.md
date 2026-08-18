# Harness X Harness Task Runner

This context describes two parallel products: asynchronous Code Tasks and ephemeral Remote Development Environments.

## Language

**Harness Principal**:
One person identified by a stable GitHub numeric user ID. The same person remains one Principal across ChatGPT, VS Code, and other MCP clients.
_Avoid_: MCP User, ChatGPT User, Client Account

**MCP Client**:
One software interface that connects to Harness and holds its own authorization grant. It does not define the owner of Tasks or Remote Development Environments.
_Avoid_: Harness Principal, User

**MCP Grant**:
One revocable permission relationship between an MCP Client and a Harness Principal. Grants remain separate even when several clients belong to the same Principal.
_Avoid_: User Account, GitHub Authorization

**Execution Repository**:
The trusted GitHub repository whose workflows allocate and operate all Code Task and Remote Development Environment runners. Access to a Target Repository does not by itself grant access to this repository.
_Avoid_: Target Repository, Workspace

**Target Repository**:
The GitHub repository that a Code Task reads or changes. Its authorization is independent of permission to use the Execution Repository.
_Avoid_: Execution Repository, Runner Repository

**Execution Authorization**:
GitHub's decision that a Harness Principal may dispatch, observe, or cancel a workflow in the Execution Repository. Harness presents a GitHub App user token scoped to that repository and `Actions: write`, so the Principal remains the GitHub actor.
_Avoid_: Organization Membership, Repository Installation, App Dispatch

**Agent GitHub Authorization**:
GitHub authorization that the user establishes inside one admitted Environment for `gh`, Git, or GitHub MCP. Harness transports its interactive login prompts but does not issue, store, refresh, or inject this credential. It ends with the Environment.
_Avoid_: Execution Authorization, MCP Grant, Harness GitHub OAuth token

**Executor Provider Credential**:
One platform-managed credential and provider endpoint configuration shared with trusted organization users so Codex and Grok work immediately inside an Environment. It is not isolated from other processes owned by that Environment user.
_Avoid_: Agent GitHub Authorization, Execution Authorization, per-user secret

**Agent Session**:
One user-delegated, multi-turn Codex or Grok conversation that retains native agent context until the user closes it or the runner expires. Parallel Sessions may use the same user-managed working directory; their native session records do not isolate filesystem state.
_Avoid_: Code Task, T3 Thread, Fixed Pipeline

**Session Controller**:
The single MCP Grant currently allowed to send turns and answer requests for an Agent Session. The owning Harness Principal may explicitly transfer control to another of their Grants.
_Avoid_: Session Owner, MCP Client, Lease

**Session Event**:
One private, ordered Agent output, lifecycle change, approval, question, or response in an Agent Session. A cursor identifies its position for reconnect without implying cross-Environment recovery.
_Avoid_: Workflow Log, Complete Transcript, MCP Notification

**Environment Control Channel**:
The single outbound WebSocket from one admitted Environment Run to its owner's EnvironmentObject. It multiplexes commands and Agent Session events for that Environment generation. Tailscale, T3, and public runner ingress are not control channels.
_Avoid_: T3 Interface, Private Network Interface, MCP connection

**Code Task**:
One asynchronous execution of one prompt that ends with a final status and result. It invokes its selected CLI driver directly and does not require T3.
_Avoid_: Environment, T3 Thread

**Remote Development Environment**:
One user-owned, general-purpose GitHub-hosted runner that exists for exactly one workflow run. It can contain zero or many repositories and can be reached through several remote clients. All files, processes, tool sessions, and credentials are destroyed when the workflow ends.
_Avoid_: Code Task, persistent Session, repository workflow

**Environment Run**:
The GitHub Actions workflow run that creates and terminates one Remote Development Environment. Its native GitHub status is lifecycle authority. The control plane stores only owner association, opaque generation, exact run identity, private delivery, and close intent.
_Avoid_: Code Task, control-plane Session

**Environment Admission**:
The OIDC-authenticated claim that binds one exact GitHub run to the current user generation before the workflow receives executor credentials, joins Tailscale, or starts T3. A workflow from a closed or older generation fails at this gate and is not a Remote Development Environment.
_Avoid_: workflow dispatch response, ready callback, repository authorization

**Connection Descriptor**:
The current private connection information for one active Environment, such as its Tailscale hostname and T3 origin or pairing entry. The runner publishes it once to the owner-specific control-plane state through GitHub OIDC.
_Avoid_: Stable Tunnel, credential log, artifact

**T3 Interface**:
One optional remote code-editor interface running inside the Environment. T3 owns its own projects, Threads, Turns, provider streams, approvals, diffs, and terminal, but it does not own Environment lifecycle.
_Avoid_: Environment control plane, MCP transport

**Private Network Interface**:
The Tailscale/Headscale connection to the Environment. It provides Tailscale SSH today and can support another remote client only when that client's protocol and required port are explicitly verified and authorized.
_Avoid_: T3 Tunnel, proof of client compatibility

**Environment Entry**:
The stable authenticated browser route that shows Preparing, redirects the owner to T3 native pairing when ready, and becomes Offline after the authoritative GitHub run terminates.
_Avoid_: Stable Tunnel, pairing-token MCP result, lifecycle authority
