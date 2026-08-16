# Use LarkSend for connection delivery

GitHub Actions is the only lifecycle control surface for a Remote Development Environment. A user manually dispatches the Environment workflow and cancels its run when finished; the GitHub-hosted platform limit is the final execution bound. The ChatGPT MCP server remains dedicated to Batch Code Tasks and exposes no Environment tools.

After T3, Quick Tunnel, and Tailscale are ready, the workflow calls LarkSend once with the current Connection Descriptor. The Lark chat is the stable private discovery channel even though the Quick Tunnel URL and Tailscale hostname belong to one run.

## Considered Options

- Adding MCP Environment tools was rejected because GitHub Actions already creates, reports, and cancels the run, while Lark already delivers its connection.
- A stable Named Tunnel was rejected as unnecessary when the stable requirement is private discovery rather than one permanent T3 origin.
- A custom ChatGPT streaming widget was rejected because native remote clients already provide the interactive experience.
