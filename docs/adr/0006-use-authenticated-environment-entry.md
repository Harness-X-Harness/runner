# Use the authenticated Environment entry for connection delivery

GitHub Actions is lifecycle authority for a Remote Development Environment.
ChatGPT exposes two narrow control surfaces: `open_environment` dispatches or
returns the caller's active run, and `close_environment` records close intent
and cancels that exact run. The GitHub-hosted platform limit remains the final
execution bound.

An explicit Open that observes a Starting, Ready, or Closing record checks only
that exact GitHub run. A confirmed terminal run permits one serialized
replacement generation in that user request. The Widget's timed observation is
an explicit read-only mode: it can reconcile the run, but cannot create a
generation or dispatch. If the original Open first sees Closing, the Widget may
consume one replacement Open after terminal evidence. A failed replacement
becomes Offline instead of recursively reopening. A Close from any client
revokes this local continuation.

After T3 and its Quick Tunnel are ready, the workflow publishes one Connection
Descriptor through a GitHub OIDC-authenticated runtime. Tailscale is a separate
best-effort administrator interface and does not enter this descriptor. The stable
control-plane Environment entry verifies GitHub browser identity before it
redirects the owner to T3's native pairing flow.

The workflow also performs an OIDC-authenticated admission claim immediately
after checkout and before credentials, private networking, T3, or Quick Tunnel.
This lets a run recover an accepted dispatch whose response was lost. Closing
before admission revokes the generation, so a delayed workflow fails at the
claim gate instead of becoming an Environment.

## Considered options

- MCP does not relay T3 interaction or own process lifecycle.
- Mandatory Lark delivery is removed. Issue #14 remains a possible optional
  integration and is not part of the Environment path.
- A stable Named Tunnel is unnecessary because the stable requirement is
  private discovery, not one permanent T3 origin.
- A custom ChatGPT streaming widget is unnecessary because native remote
  clients already provide the interactive experience.
