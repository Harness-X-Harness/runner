# Harness X Harness Task Runner

This context describes two parallel products: asynchronous Code Tasks and ephemeral Remote Development Environments.

## Language

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
