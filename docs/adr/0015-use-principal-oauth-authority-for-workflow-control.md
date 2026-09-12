# Use Principal OAuth authority for workflow control

Status: accepted for Task workflow control. Its former in-Environment Agent
login policy is superseded by the [Task product](https://github.com/Harness-X-Harness/runner/issues/114).

Harness identifies the Principal through a GitHub App and derives a user token
limited to the Execution Repository and `Actions: write`. Only that scoped
token dispatches, observes and cancels the exact workflow run, so GitHub applies
the real Principal's repository access and policy. The base access token is
not retained.

OAuth completion proves identity, not separate organization membership or
preflight repository authority. The real workflow dispatch is the Execution
Authorization gate. There is no App JWT, installation token, broad OAuth
`repo` scope or alternate platform authority for workflow control.

The control-plane credential stays encrypted in the OAuth grant; it does not
enter workflow input, Agent execution, MCP output or logs. Agent work separately
uses the explicitly approved fixed GitHub identity. Its target rights are not
each Principal's rights.

This keeps one workflow authority and accepts conditional reconciliation:
without valid user authority, Harness cannot observe or cancel on that user's
behalf. GitHub still bounds the job lifetime. An independent scavenger would
be a separate product decision, not a fallback in this path.
