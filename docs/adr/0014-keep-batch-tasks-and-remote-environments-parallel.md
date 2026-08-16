# Keep batch tasks and remote environments parallel

Batch Code Tasks and Remote Development Environments are parallel product capabilities. The existing `submit_task`, `get_task`, `get_task_result`, and `cancel_task` tools continue to dispatch one-shot workflows that invoke their selected CLI drivers directly.

Remote Development Environments remain a GitHub Actions and Lark workflow. The ChatGPT MCP server exposes no Environment tools, does not send instructions to Codex or Grok in the Environment, does not relay T3 traffic, and does not turn an Environment into a Code Task.

The products may share repository configuration and installed tools, but not runtime state or control flow. A failure in one path cannot change the other's semantics.
