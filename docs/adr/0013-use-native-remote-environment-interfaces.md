# Use native remote environment interfaces

Users operate a Remote Development Environment through native interfaces already suited to continuous interaction: the complete T3 page, Tailscale SSH, and any separately verified remote client. The control plane does not build another terminal, editor, provider stream, or Agent conversation UI.

Tailscale network reachability is necessary but does not by itself prove an upper-layer client is compatible. Each added remote client must have its actual protocol, port, authentication, and end-to-end connection verified. The current Headscale policy grants administrator access to tagged runners on TCP port 22.

T3 Web temporarily keeps its Cloudflare Quick Tunnel because it needs an HTTPS access path. This public transport remains distinct from the private Tailscale interface and still relies on T3's native pairing and session authentication.

## Considered Options

- A ChatGPT terminal or streaming widget was rejected as duplicate UI and transport.
- Treating every Tailscale-reachable application as supported was rejected because network reachability is not an application protocol contract.
- Removing Quick Tunnel before a Tailscale HTTPS path is verified was rejected because it would remove the current usable T3 Web entrypoint.
