# Keep batch tasks and remote environments parallel

Batch Code Tasks and Remote Development Environments are parallel product capabilities. The existing `submit_task`, `get_task`, `get_task_result`, and `cancel_task` tools continue to dispatch one-shot workflows that invoke their selected CLI drivers directly.

Remote Development Environments use the no-input `open_environment` and
`close_environment` tools plus a GitHub Actions workflow. The ChatGPT MCP
server does not send instructions to Codex or Grok in the Environment, relay
T3 traffic, or turn an Environment into a Code Task.

The products may share repository configuration and installed tools, but not runtime state or control flow. A failure in one path cannot change the other's semantics.
