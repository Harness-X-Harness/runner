# Treat T3 as one environment interface

T3 is one remote code-editor interface installed in a Remote Development Environment. It owns its native projects, Threads, Turns, provider adapters, streams, approvals, diffs, and terminal. The control plane does not recreate or interpret those features.

T3 is not the Environment identity, durable state owner, or required transport. A user may also connect through Tailscale SSH or another explicitly supported remote client. Agent Sessions use their native Codex and Grok drivers over the Environment Control Channel and do not require T3.

## Considered Options

- Making T3 the Environment control plane was rejected because the Environment exists independently of one editor.
- Reimplementing T3's interactive features in ChatGPT was rejected as duplicate infrastructure.
- Routing Agent Session control through T3 was rejected because it would make one optional editor a transport authority.
