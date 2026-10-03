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
Browser regression is a separate local command; CI does not install a browser.

## Evidence boundary

Use this preview for layout, text, input, buttons and frontend regression.
Use the retained authorized SDK client separately for real MCP/runtime tests.
A passing local preview does not prove ChatGPT's sandbox, permissions, resource
discovery, or model/backend behavior. A bounded real-host smoke test is needed
when those integration boundaries change, not for each text or layout change.

Do not add a second card implementation or runtime state machine to the preview.
Add a fixture to `apps/chatgpt-app/preview/scenarios.ts` for a new display state.
