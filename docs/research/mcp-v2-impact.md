# MCP 2026-07-28 对代码任务控制面的影响

> 历史研究（2026-08）：本文评估的是已经删除的一次性 Code Task 产品。当前产品只使用 Agent Sessions。下文的 Task 建议不是现行实现指导。

研究日期：2026-08-16

## 结论

Cloudflare 文章中的“MCP v2”不是一个要求重写业务架构的产品版本。它主要指 MCP
`2026-07-28` 协议修订和 TypeScript SDK v2。新协议把 MCP 的**传输状态**移出核心请求路径，
但没有消除应用自己的持久状态。[Cloudflare 的发布说明](https://blog.cloudflare.com/mcp-v2/)
明确建议：普通 MCP 请求直接运行在 Worker 上；只有应用本身需要协调状态时才使用 Durable
Objects。

这与本项目的边界一致：`/mcp` 只负责接收工具调用，`TaskObject` 负责跨 GitHub Actions
dispatch、callback、取消和迟到事件的任务状态。因此，升级 MCP SDK 后仍应保留 Durable Object，
也不应把任务状态移回 MCP transport session。

当前最合理的路线是：

1. 保留现有 `submit_task`、`get_task`、`get_task_result` 和 `cancel_task` 产品契约。
2. 在独立变更中升级 OAuth provider，并把无会话 MCP handler 迁移到 SDK v2 factory；保持
   `/mcp` URL 不变。
3. 保留 Client ID Metadata Documents（CIMD）并暂时保留 Dynamic Client Registration
   （DCR）兼容入口。
4. 等 Cloudflare Agents SDK 和 ChatGPT 客户端明确支持 Tasks 扩展后，再评估用一个标准 task
   tool 取代三个查询/取消工具。
5. 不为当前四个固定工具引入 Code Mode、Sampling、Roots 或新的 session 层。

## 新协议实际改变了什么

| 改变 | 具体含义 | 对本项目的意义 |
| --- | --- | --- |
| 无状态核心 | 移除必需的 `initialize`/`initialized` 握手、`Mcp-Session-Id` 和协议 session；每个请求携带协议版本、client identity 和 capabilities。`server/discover` 是可选的。([MCP 官方发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)) | 当前工具调用不依赖 session，可以直接迁移到 request-scoped server factory。 |
| Multi Round-Trip Requests（MRTR） | 服务端需要用户输入时返回 `input_required`；客户端收集输入后带 `inputResponses` 重发原请求，不需要保持双向流。([Cloudflare](https://blog.cloudflare.com/mcp-v2/)) | 未来可用于原生展示 GitHub 安装链接或确认，但不能替代长时间的组织审批和后台任务存储。 |
| HTTP header 路由 | Streamable HTTP 必须携带 `Mcp-Method`，适用时还带 `Mcp-Name`；SDK校验 header 与 JSON body 是否一致。([MCP 官方发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)) | 可按 `submit_task` 做速率限制和指标，但 header 不是授权证明；OAuth scope 检查必须保留。 |
| 可缓存列表 | `tools/list`、`prompts/list`、`resources/list` 和 `resources/read` 可返回 `ttlMs` 与 `cacheScope`，列表顺序确定。([Cloudflare](https://blog.cloudflare.com/mcp-v2/)) | 本项目只有四个稳定工具，收益较小。工具定义含授权元数据时，不应在未验证授权上下文隔离前声明跨用户缓存。 |
| OAuth 加固 | 优先预注册 client，其次 CIMD；DCR 被弃用但仍在兼容期。新增 RFC 9207 issuer 校验，并要求 RFC 8707 `resource` audience。([Cloudflare](https://blog.cloudflare.com/mcp-v2/), [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)) | 当前已启用 CIMD，但固定的 provider 版本早于新的 CIMD 获取防护和 ChatGPT 协商修复；还需单独评估是否把 resource 从默认 origin 固定为完整 `/mcp` URI。 |
| 扩展框架 | MCP Apps、Enterprise-Managed Authorization 和 Tasks 不再挤入核心协议。Tasks 成为 `io.modelcontextprotocol/tasks` 扩展。([MCP 官方发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)) | Tasks 与本项目领域高度匹配，但现在不是可直接依赖的核心能力。 |
| 弃用策略 | Roots、Sampling、Logging、DCR 和旧 HTTP+SSE transport 被弃用；弃用功能至少保留 12 个月。([Cloudflare](https://blog.cloudflare.com/mcp-v2/)) | 本项目不依赖 Roots、Sampling、Logging 或旧 SSE。DCR 应在客户端生态确认 CIMD 后再删除。 |

这里有一个容易混淆的点：**stateless MCP 不等于 stateless application**。MCP 官方建议应用若需要
跨调用状态，应显式产生 handle，并让调用方在后续请求中携带它，而不是把状态隐藏在 transport
session 中。([MCP 官方发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/))
本项目的 `taskId` 已经是这种显式 handle。

## 与当前实现的映射

当前依赖为 `agents@0.20.1`、`@modelcontextprotocol/server@2.0.0` 和
`@cloudflare/workers-oauth-provider@0.10.3`，见
[`apps/chatgpt-app/package.json`](../../apps/chatgpt-app/package.json)。MCP server 仍从
`agents/mcp/server` 和 SDK v2 导入。四个工具通过公开 `registerTool` 注册，OAuth
元数据同时保留在 `_meta.securitySchemes`；因为 SDK v2 的 wire schema 不允许 Apps SDK
扩展字段，Worker 在 `tools/list` 响应边界补回顶层 `securitySchemes`，不访问 SDK 私有
handler map，见 [`mcp.js`](../../apps/chatgpt-app/src/mcp.js)。

| 当前组件 | MCP 2026-07-28 映射 | 判断 |
| --- | --- | --- |
| Worker `/mcp` | `agents/mcp/server` 的 `createMcpHandler(factory)` | 已迁移，URL 不变。Cloudflare 的 handler 同时服务 2026 客户端和旧的 stateless Streamable HTTP 客户端。([Handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)) |
| 四个 MCP tools | 普通 SDK v2 tools | 继续保留。输入、输出和 side-effect annotations 是产品契约，不是协议 session。 |
| `TaskObject` Durable Object | 应用 task store | 必须保留。它序列化 callback、取消和迟到事件；新协议只消除 protocol session storage。([Cloudflare](https://blog.cloudflare.com/mcp-v2/)) |
| `workers-oauth-provider` + KV | MCP OAuth resource/authorization server | 继续保留，已升级到 `0.10.3`。该库的后续版本加入 RFC 9207、严格 RFC 8707 resource policy，以及 ChatGPT CIMD negotiation 与多设备 grant 修复。([官方 changelog](https://github.com/cloudflare/workers-oauth-provider/blob/main/CHANGELOG.md)) |
| GitHub OAuth + App installation | 上游身份与 repository authority | 不受 MCP v2 取代。MRTR 只能改善交互表现，不能证明安装权限。 |
| GitHub Actions callback | 外部异步执行结果 | 不受 stateless transport 影响；仍需 task ID、OIDC callback 和 Durable Object 状态机。 |

当前实现没有 `McpAgent`，也没有 MCP protocol session Durable Object，所以不存在需要迁移或排空的
MCP session。Cloudflare 的双路由方案只适用于依赖 session、RPC、push、standalone stream 或 replay
的服务；本项目没有理由新增 legacy lane。([迁移指南](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/))

## 对用户体验的参考

### 现在可以保留的体验

用户继续调用 `submit_task` 并立即得到 `taskId`。之后用 `get_task`、`get_task_result` 或
`cancel_task` 操作显式任务。这个流程虽然不是最新协议原语，但它已经具备断线后查询、独立取消、
所有权校验和 GitHub run callback 收敛，不依赖 MCP 长连接。

SDK v2 的 transport 升级原则上对用户透明：Cloudflare 表示同一个 `/mcp` handler 可兼容新的
`2026-07-28` 请求和旧的无状态 2025 Streamable HTTP client。([Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/))

### 值得未来采用的体验

1. **URL elicitation**：当仓库缺少 GitHub App installation 时，`submit_task` 可返回标准
   `input_required` URL 请求，让 MCP client 用原生授权 UI 打开 GitHub。完成后 client 重发原请求。
   这可减少用户手工复制链接，但前提是目标 client 完整支持 MRTR URL elicitation。
2. **Tasks 扩展**：一个 task-augmented `submit_task` 可返回标准 task handle；client 使用
   `tasks/get`、`tasks/result` 和 `tasks/cancel`，从而让用户不再看到三个领域工具。`input_required`
   还可表达待安装状态。

这两项不能立即合并。Cloudflare 明确说明 Agents SDK `0.20.0` **没有实现 Tasks 扩展**，Tasks
仍是扩展且 API 处于实验状态。([Cloudflare 迁移指南](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/),
[MCP Tasks 官方文档](https://modelcontextprotocol.io/extensions/tasks/overview))。
当前也没有一手资料证明 ChatGPT App client 已支持 `io.modelcontextprotocol/tasks`。在客户端能力未知时
删除现有查询工具，会让已经工作的任务流程失去可用入口。

此外，GitHub 组织审批可能超过一次 tool call 的合理生命周期。即使使用 MRTR，任务和审批状态仍需
Durable Object 持久化。协议原语能改进 UI，不会删除业务状态机。

## 最低成本迁移路径

### 阶段一：OAuth provider 与 SDK v2 transport，保持产品契约

在一个独立 PR 中：

1. 已把 `workers-oauth-provider` 从 `0.8.2` 升到 `0.10.3`。该版本修复了 ChatGPT 的
   `private_key_jwt`/`none` negotiation，并避免 CIMD client 在一台设备重新授权时注销其他设备
   grant；`0.9.0` 才加入 RFC 9207 和严格 resource policy。([官方 changelog](https://github.com/cloudflare/workers-oauth-provider/blob/main/CHANGELOG.md))
2. 已把 `agents` 升到 `0.20.1`，并使用其精确 peer 对应的
   `@modelcontextprotocol/server@2.0.0`。([Handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/))
3. 将 MCP server import 改为 `@modelcontextprotocol/server`，handler 改为
   `agents/mcp/server`。
4. 将 `createServer(env, props)` 改为每个请求创建 server 的 factory；四个工具及其 callback
   保持不变。
5. 把 `inputSchema` 和 `outputSchema` 改为显式 `z.object(...)`。SDK v2 推荐 Standard Schema，
   raw shape overload 已弃用。([SDK v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md))
6. 已删除 SDK v1 私有 `_requestHandlers` 补丁。v2 的公开注册保留 `_meta.securitySchemes`，
   Worker 只在最终 `tools/list` HTTP 响应边界恢复 Apps SDK 所需的顶层扩展字段；这不依赖 SDK
   私有状态，也不改变 MCP 工具调用处理。
7. 保持 `/mcp`、OAuth scope、tool name、task schema 和 Durable Object binding 不变。
8. 已用本地旧 stateless Streamable HTTP 请求和 `2026-07-28` 请求验证工具列表与元数据；部署后
   仍需用真实 ChatGPT App 做 clean-login 和一个代表性任务工具流验证。Cloudflare 要求迁移时单独
   测试新旧 client、OAuth、Origin、取消和 transport loss。
   ([迁移指南](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/))

### 阶段二：OAuth audience 显式化（已部署）

Worker 已把 `resourceMetadata.resource` 固定为
`TASK_CONTROL_PLANE_URL` 对应的完整 `https://…/mcp` URI，并显式发布同一 Worker origin 的
`authorization_servers`。Workers OAuth Provider 会把授权和 token 绑定到这个 canonical resource，
对显式不匹配的 `resource` 请求、未绑定 token 和错误 audience 的 API token 进行拒绝。
([Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider))
Worker 还在 `/authorize` 和 `/oauth/token` 边界要求请求明确携带 `resource`；缺失值会在 provider
处理前返回 `invalid_target`，而重复或不同值交给 provider 返回带有安全 redirect context 的标准
OAuth 错误。Token revocation 保持 RFC 7009 的独立请求形态，不要求 resource。

这是一次有意的授权边界变化：部署前创建的 origin-only grant 不能作为新的 `/mcp` audience 证据。
应在发布后完成一次 ChatGPT clean login，再验证工具调用、refresh、第二设备授权和旧 grant 的拒绝
行为。不要使用 `resourceMatchOriginOnly` 作为永久 fallback；当前实现没有保留该兼容路径。

回滚边界是恢复上一版 Worker 代码和同一 KV binding；不要删除 `OAUTH_KV`。如果回滚后继续使用
新 `/mcp` grant，应预期重新完成一次授权，因为旧版本的 origin-only audience 与新版本不等价。

DCR endpoint 暂时保留。CIMD 已启用，DCR 只承担旧 client 兼容；在确认实际 ChatGPT client 使用
CIMD 后再删除，符合至少 12 个月的弃用窗口。

### 阶段三：有证据后采用交互扩展

只有同时满足以下条件才迁移到 Tasks 或 MRTR：

- Cloudflare Agents SDK发布并文档化对应 extension；
- ChatGPT App client 宣布并实测对应 capability；
- 任务所有权、取消竞态、安装审批和迟到 callback 的现有验收用例可以映射到标准状态；
- 老 client 有明确兼容或退场策略。

Tasks 最终可把公开接口收敛为一个 task-aware `submit_task`。但 Durable Object 仍应作为 TaskStore；
`awaiting_installation` 映射为 `input_required`，`cancel_requested` 映射为 `working` 加
`statusMessage`，而不是扩展标准终态。

## 不建议采用的内容

- **不要删除 Durable Object**：它保存产品任务，不是 MCP session。
- **不要马上删除 DCR**：规范已弃用不等于现有 client 已停止使用。
- **不要现在改成 Tasks 扩展**：Cloudflare SDK未实现，ChatGPT 支持未知。
- **不要为了四个工具引入 Code Mode**：Cloudflare 推荐 Code Mode 的主要理由是压缩数千个 API
  schema；本项目只有四个目标明确的工具。([Cloudflare MCP server catalog](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/))
- **不要用 `Mcp-Method` 或 `Mcp-Name` 做授权**：它们适合路由、限流和观测；真正权限仍来自 OAuth
  token、scope、原用户身份与 GitHub App installation 校验。
- **不要建立 legacy MCP route**：当前实现没有 sessionful feature，双路由只增加测试面。

## 最终判断

MCP 2026-07-28 对当前项目最重要的价值有两个：

1. 它正式确认“稳定 Worker 控制面 + 显式 task ID + Durable Object 业务状态 + 临时 GitHub Actions
   执行面”是正确分层。
2. 它提供了未来消除 `get_task`、`get_task_result`、`cancel_task` 三个显式工具的标准方向，但当前
   SDK和客户端证据不足，不能以新协议名义提前删除已验证流程。

因此，近期工程目标应是**迁移 transport 实现但冻结产品接口**；用户体验的第二次简化应等待
Tasks/MRTR 在 Cloudflare 与 ChatGPT 两端均可验证后再做。
