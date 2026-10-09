# Frontend preview

Use the project [design rules](../../design.md) for layout, color and grouping.

The local workbench serves the same HTML, CSS and JavaScript as the MCP card.
It uses the installed MCP Apps `AppBridge` with no MCP client. Tool results are
typed local fixtures. It does not read secrets, request OAuth, start runners,
execute commands or call a model. The server binds to `127.0.0.1` only.

## Start and inspect

Use Node.js 24:

```bash
npm ci --prefix apps/chatgpt-app
npm run preview:ui --prefix apps/chatgpt-app
```

Open the printed URL. If port 4173 is already in use, choose a free port:

```bash
PREVIEW_PORT=4174 npm run preview:ui --prefix apps/chatgpt-app
```

- Choose a scene: empty/list, opening, ready, working, question, result, failure,
  cancellation, closing, closed, unavailable or capacity rejection.
- Choose Codex/Grok, light/dark and desktop/narrow width.
- Use **长结果** to review Markdown headings, lists, quotes, code and tables.
  Code and tables scroll inside the reply; ordinary paragraphs wrap.
- Use **重置场景** to clear local interactions. Changing the scene or executor
  also resets the card. Theme and width changes preserve the current card.
- Edit `apps/chatgpt-app/ui/`, then reload the browser to rebuild the real card.
- Right-click the header's **此场景的地址** icon to copy the scene URL. It contains only display settings,
  not entered prompts or credentials. It opens on the same local machine.
- Give feedback with the scene URL, the button sequence and a screenshot.

## Interaction examples

| Start scene | Actions | Expected UI |
| --- | --- | --- |
| 空列表 | Open an executor → 刷新 | Opening, then ready with a prompt field |
| 就绪 / 发送 | Enter text → 发送 → 刷新 | Working, then `PREVIEW_OK` |
| 执行中 / 停止 | 停止 → confirm → 刷新 | Cancelled; the workspace remains usable |
| 等待回答 | Pick a color → 提交 → 刷新 | Final response includes the selected color |
| 完成 / 结果 | 关闭 → confirm → 刷新 | Closed; no future usage countdown |
| 已关闭 / 保留结果 | Read the card | Retained result, but no send/close button or usage deadlines |

The preview does not push state or poll. Refresh is explicit, as in ordinary
Chat. Fixture steps advance on that read, not through a simulated runtime.
Local example deadlines are display data, not running expiry timers.

**回复延迟** keeps buttons busy for a chosen interval. **下一次工具调用** can reject
one request without accepting it, or simulate an accepted request whose
response is unconfirmed. That choice applies once, then returns to normal.
Use it on **发送** to review the input and recovery UX. It is not a real network
timeout, nor proof of server-side idempotency. Use the header's **交互记录** icon
to show the log and its entry count. The interaction log shows tool
arguments, fixture responses and outgoing chat messages. **在对话中回答** only
logs the message; it never asks ChatGPT to answer. The header's pixel icons keep
accessible names for refresh, list and close, with hover/focus hints. Send stays
inside the composer; technical IDs stay in the tool/context data, not a details
panel. Ready uses a short filled bar; operation failures remain separate text.

Agent replies use Markdown; command output and progress logs remain raw text.
Raw HTML is ignored and image descriptions appear without loading images.
Clicking a reply link only records a standard host link request in this preview;
it does not navigate or fetch the target. Product hosts control actual link opening.

## Automated checks

```bash
npm test --prefix apps/chatgpt-app
npm run typecheck --prefix apps/chatgpt-app
```

These check display contracts, rendered closed-state deadlines and that the
preview serves the production artifact. The ordinary repository CI includes
these checks.

With `agent-browser` and its Chrome runtime installed, run browser regression:

```bash
npm run test:ui --prefix apps/chatgpt-app
```

This creates its own headless browser session and loopback server, then closes
both. It does not restore a login or touch existing browser sessions. Tests
cover the actual iframe bridge, send/busy/refresh, stop and close confirmation,
answers, rejection/unconfirmed-response UX, and all narrow dark-mode scenes.
Browser regression also runs in the focused Semantic presentation TDD workflow,
using pinned `agent-browser@0.38.2` and the hosted Ubuntu Chrome executable.

## Evidence boundary

Use this preview for layout, text, input, buttons and frontend regression.
Use the retained authorized SDK client separately for real MCP/runtime tests.
A passing local preview does not prove ChatGPT's sandbox, permissions, resource
discovery, or model/backend behavior. A bounded real-host smoke test is needed
when those integration boundaries change, not for each text or layout change.

Do not add a second card implementation or runtime state machine to the preview.
Add a fixture to `apps/chatgpt-app/preview/scenarios.ts` for a new display state.

Command fixtures cover success, nonzero exit, cancellation with full outcome,
timeout, truncation, historical results with active work and deceptive stdout.
The untrusted JSON scene keeps model-authored JSON in Markdown without creating
command evidence. All scenes are checked at 375px and 780px in both themes.
The browser suite also checks literal logs, keyboard scrolling, unchanged-result
scroll position, safe confirmation focus and exact active-operation cancellation.

The full-outcome cancellation fixture exercises the display contract only.
Current Task projection omits outcomes for cancelled Tasks; that real shape falls
back to the operation's cancellation label and literal output snapshot. Missing
command evidence must not be reconstructed from that snapshot.


## Launcher and context acceptance (#217 / #218)

The [tool-to-UI matrix](../chatgpt-app.md#chat-workbench) reserves Workbench
launching for `list_environments` and `open_environment`. Ordinary
command/agent/inspect calls have no Workbench URI. Repeated launchers can still
create independent cards; chat calls cannot be forced to converge on one view.
Existing-card Refresh reads once and replaces its snapshot in place.

In the ready scene, choose **运行命令**, enter `["git", "status", "--short"]`
and a timeout, run, then refresh. This returns literal fixture output and the
trusted command panel without executing a command. Choose **查看操作结果** to
inspect a retained operation ID. Stop uses the active ID even while an older
command result is selected. Unknown command response fixtures retain argv,
timeout and the original submission key; only an explicit identical retry
uses that key. They do not prove runtime idempotency.

**Use this environment in chat** publishes just the Environment ID on click.
The interaction trace records that request and its acknowledgement. Opening,
listing, selecting and refreshing never publish Model Context. Repeat clicks
in the same card are suppressed after acknowledgement. `?scene=ready&context=unsupported`
omits the capability; `?scene=ready&context=fail-once` rejects the first request
so visible feedback and retry can be checked. `?scene=ready&multiple=1` mounts
two independent AppBridge cards. The automated suite sends late results to
both and verifies no automatic publication. These loopback fixture controls are
not included in the production card.

Browser tests use the production routing rule to simulate host view creation;
unit tests separately verify all seven discovered tools, visibility, scope and
URI metadata. The simulated host creates views only for advertised launchers
and does not create views for in-card `callServerTool` responses. This proves
our routing and bridge behavior locally, not ChatGPT's actual presentation
policy. The real host must independently verify launcher behavior, ordinary
chat tools, in-place refresh, literal command logs, explicit context and native
Tasks result handoff. Cross-view scope and ordering remain host-dependent;
there is no global selection service or background polling.
