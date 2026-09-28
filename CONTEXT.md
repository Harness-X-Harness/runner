# Harness X Harness

Harness X Harness gives an authorized GitHub user a temporary Environment for
commands and coding-agent interaction, with private observable Task results.

## Language

**Harness Principal**:
One person identified by a stable GitHub numeric user ID. The same person is
one Principal across ChatGPT, VS Code and other MCP clients.
_Avoid_: MCP User, ChatGPT User, Client Account

**MCP Client**:
One software interface that connects to Harness and holds an authorization
grant. It does not own Tasks independently of the Principal.
_Avoid_: Harness Principal, User

**MCP Grant**:
One revocable permission relationship between an MCP Client and a Harness
Principal. Several clients can hold separate grants for the same Principal.
_Avoid_: User Account, GitHub Authorization

**Environment**:
A Principal-owned, bounded runtime with one workspace, selected executor and
native Agent session. Its lifetime is separate from each operation's lifetime.
_Avoid_: Task, desktop session, permanent machine

**Task**:
The owner-private outcome of a long Environment operation, including creation,
an Agent turn, a command or closure. Its terminal outcome is immutable.
_Avoid_: Agent Session, conversation, fixed pipeline

**Execution Repository**:
The trusted GitHub repository whose workflow allocates temporary runtimes.
_Avoid_: Workspace, target repository

**Execution Authorization**:
The Principal's GitHub authority to dispatch, observe or cancel a workflow in
the Execution Repository. It is distinct from the Agent's target-repository rights.
_Avoid_: Organization Membership, App dispatch, Agent GitHub Authorization

**Execution**:
One exact GitHub workflow run and attempt admitted to one Environment. An ended
execution cannot be replaced by another run under the same Environment.
_Avoid_: Task, native thread, retry

**Agent GitHub Authorization**:
The explicitly approved fixed GitHub identity supplied to the Agent for target
work. Its rights do not shrink to each submitting Principal's target access.
_Avoid_: Execution Authorization, per-user repository permission

**Executor Provider Credential**:
Platform-managed private provider access that lets Codex or Grok execute the
Task. It is shared only with trusted users through their Agent executions.
_Avoid_: Agent GitHub Authorization, MCP Grant

**Final Response**:
The selected Agent's semantic final text after successful native completion.
It is not a platform certification that the prompt's business objective succeeded.
_Avoid_: stdout, transcript, progress stream

**Cancellation**:
An intent to stop Task execution. It cannot undo external effects, and an
accepted terminal response or failure can win before cancellation is confirmed.
_Avoid_: rollback, immediate termination
