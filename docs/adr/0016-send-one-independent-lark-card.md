# Send one independent Lark card

The Environment workflow calls a reusable LarkSend Action once, after T3, Quick Tunnel, and Tailscale are ready. The non-forwardable card contains the Environment and GitHub run identity, current Tailscale SSH hostname, native T3 origin and pairing actions, and a GitHub run action.

LarkSend reads the native T3 origin and pairing URL from the runner-local mode-0600 connection files, resolves the exactly configured chat name, and sends one card. It has no Starting, Online, or Offline state, stores no message ID, performs no PATCH, and registers no post-run cleanup. The Action owns the ready connection-card presentation but does not own or infer Environment lifecycle.

## Considered Options

- Retaining the update lifecycle was rejected because it couples a generic send operation to one Environment state machine and cannot reliably run after forced termination.
- Plain text was rejected because the current private card provides safer non-forwarding behavior and clearer connection actions.
