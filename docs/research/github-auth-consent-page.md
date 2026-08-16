# GitHub 用户授权与 MCP consent 页评审

研究日期：2026-08-16

实施状态：本文评审的基线是 commit `b768263`。同日的后续 working tree 已按本文建议实现
clickjacking 防护、browser-bound GitHub state、S256 PKCE、显式拒绝、redirect-aware OAuth
错误、人类可读 scope 和 mode-specific incremental authorization。PR #51 已合并并部署；本地
测试、default-branch CI、Worker health 和 OAuth metadata 检查通过。真实浏览器 consent、拒绝、
GitHub callback 和 ChatGPT step-up 仍待验收。真实 ChatGPT 手工连接进一步证明：客户端会把所有工具
声明的 scope 聚合成一个初始授权请求，即使初始 `WWW-Authenticate` 和 protected-resource metadata
都只声明 `tasks:read`。后续修复在 authorization server 边界把这个精确的全能力集合缩减为
`tasks:read`；按操作产生的 scope 子集保持不变。真实 Cancel 验收随后暴露了另一个边界：每个 GET
都以页面 CSRF 覆盖同一 cookie，使重复或并发授权页互相失效。后续修复改为一个短期浏览器会话
cookie，加每页独立的一次性 KV token；KV 只保存浏览器会话哈希。下文“当前实现”和差距章节保留
对评审基线的描述。

## 精确问题

当前 Worker 在把用户送到 GitHub App 授权前，自行渲染一个权限请求页。这个实现是否符合
OAuth、MCP、GitHub 和 ChatGPT 的当前最佳实践？是否存在可以直接替代它的标准库？在保持
Cloudflare Worker 和 radical KISS 的前提下，应该改到什么程度？

## 结论

**当前实现的协议骨架正确，但 consent 页还不是生产级最佳实现。**

需要先区分两个页面：

1. Worker 的 `/authorize` 是 **MCP authorization server 的 consent 页**。它决定 ChatGPT 等
   MCP client 可以获得哪些本项目 scope。这个页面由本项目负责。
2. 随后的 `github.com/login/oauth/authorize` 是 **GitHub App 用户授权页**。它展示 GitHub App
   的账户权限，并由 GitHub 托管。本项目没有自行实现 GitHub 的权限 UI。

因此，“把简陋页面换成 GitHub 标准页”不是有效方案。GitHub 页只能认证用户并授权 GitHub App；
它不能代表用户同意把 `tasks:run`、`repos:write` 等 MCP 权限授予 ChatGPT。Cloudflare 明确要求：
当 MCP server 代理到 GitHub 等上游 OAuth provider 时，必须在跳转上游前提供自己的 consent
dialog，以防 confused-deputy 和缓存授权被滥用。([Cloudflare security guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#consent-dialog-security))

本项目已经使用正确的核心协议库
[`@cloudflare/workers-oauth-provider@0.10.3`](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md)。
它负责 MCP/OAuth discovery、CIMD、DCR、PKCE、authorization code、token、refresh、revocation、
resource audience 和 KV 中的敏感值保护。它有意**不提供登录或 consent UI**，因为用户认证、
授权策略和产品文案必须由应用决定。([0.10.3 authorization endpoint](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md#authorization-endpoint))

Radical-KISS 方案不是引入 React、Hono 或另一套 auth framework。建议继续使用当前协议库，保留
一个无 JavaScript 的静态 HTML form，并补齐少量安全和协议行为。

## 当前流程

当前代码在 [`index.js`](../../apps/chatgpt-app/src/index.js) 中执行：

1. `parseAuthRequest()` 校验 MCP client、redirect URI、response type、resource 和 PKCE。
2. `lookupClient()` 取得 CIMD、DCR 或预注册 client 的名称。
3. 生成 10 分钟的单次页面 CSRF，把 `authRequest` 与短期浏览器会话哈希放进 `OAUTH_KV`，并通过
   `__Host-RUNNER_CSRF` 安全 cookie 绑定 consent POST。同一浏览器的并发页面共享会话 cookie，
   但使用不同的页面 CSRF 和 KV record。
4. 页面显示 client name 和请求的内部 scope；用户只能选择 `Continue with GitHub`。
5. POST 成功后，生成第二个随机 `state`，把 `authRequest` 保存 10 分钟，然后跳转 GitHub。
6. GitHub callback 交换 user access token，读取稳定的 numeric user ID，再调用
   `completeAuthorization()` 创建 MCP grant。GitHub token 的刷新生命周期由
   [`github-user-auth.js`](../../apps/chatgpt-app/src/github-user-auth.js) 与 provider 的
   `tokenExchangeCallback` 对齐。

## 哪些部分已经符合标准

| 当前行为 | 判断 | 依据 |
| --- | --- | --- |
| 使用 `parseAuthRequest()`，不相信原始 `client_id` 和 `redirect_uri` | 正确 | Provider 明确要求先校验 client、redirect URI、response type、resource 和 PKCE，再认证和 consent。([Cloudflare provider 0.10.3](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md#authorization-endpoint)) |
| 展示通过 `lookupClient()` 得到的 client name，并对 HTML 特殊字符转义 | 正确 | Cloudflare 把 client metadata 视为不可信输入，要求在渲染前清理。([Cloudflare input sanitization](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#input-sanitization)) |
| consent POST 使用随机值、`__Host-`、`HttpOnly`、`Secure`、`SameSite=Lax` 和 10 分钟 TTL | 正确基础 | Cloudflare 给出的 consent CSRF 模式使用相同属性。([Cloudflare CSRF protection](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#csrf-protection)) |
| consent 和 GitHub state 在 KV 中短期保存，并在使用时删除 | 正确基础 | Cloudflare 建议用短期 KV state 并在 callback 后删除。([Cloudflare state handling](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#state-handling)) |
| GitHub authorization URL 使用 App `client_id`、精确 callback 和随机 `state` | 正确 | GitHub 强烈建议精确 `redirect_uri` 和随机 `state`，callback 必须核对 state。([GitHub user-token web flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token)) |
| GitHub App authorization request 不发送 OAuth `scope` | 正确 | GitHub App user token 不使用 OAuth scopes；权限是 App 权限与用户权限的交集，token 响应的 `scope` 为空。([GitHub user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#about-user-access-tokens)) |
| 用 immutable numeric GitHub user ID 作为本地身份 | 正确 | GitHub 要求用稳定的 `id`，不要用可变 login、email 或组织 slug 作为授权身份。([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#check-authorization-thoroughly-durably-and-often)) |
| 使用到期 GitHub user token 并实现 refresh | 正确 | GitHub 强烈建议到期 user token；默认 access token 8 小时、refresh token 6 个月。([GitHub token lifecycle](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-a-refresh-token-to-generate-a-user-access-token)) |
| MCP scope 与 GitHub App 权限分开 | 正确 | GitHub App 用户授权与 App installation 是不同授权；user token 只能访问用户和 App 都可访问的资源。([GitHub authorization vs installation](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps#difference-between-authorization-and-installation)) |

## 哪些内容不是标准强制的 UI

OAuth 和 MCP 规定的是授权决策、参数、错误、redirect、token 和安全边界，不规定页面必须使用哪种
颜色、logo、布局或前端框架。MCP 规范也明确说 authorization server 与用户交互的具体实现超出
协议范围。([MCP authorization roles](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#roles))

因此，下列内容属于产品设计，而不是协议互操作要求：

- 是否显示 logo、GitHub avatar 或 client homepage；
- scope 是列表、卡片还是折叠详情；
- 按钮颜色和页面布局；
- 是否允许逐个取消 scope。OAuth 允许 authorization server 根据策略或用户决定缩小 scope，但
  不要求逐项选择。([OAuth 2.1 scope](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-1.4.1))

但是，UI 不是安全无关。页面必须让用户知道“哪个 MCP client 请求什么能力”，并且不能被 iframe
覆盖诱导点击。

## 差距与优先级

### P0：授权页缺少 clickjacking 防护

当前 CSP 没有 `frame-ancestors 'none'`，也没有 `X-Frame-Options: DENY`。OAuth 2.1 要求
authorization server 防止 clickjacking，并建议在 authorization、login 和 error 页面同时使用
CSP。([OAuth 2.1 clickjacking](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-7.10),
[Cloudflare CSP example](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#content-security-policy))

最小修复：在现有 `html()` response 增加 `frame-ancestors 'none'`、`base-uri 'none'` 和
`X-Frame-Options: DENY`。不需要 JavaScript 或 UI framework。

### P0：上游 GitHub `state` 没有绑定当前浏览器 session

当前 callback 只证明 `state` 存在于 KV；它没有证明 callback 回到了启动该上游授权的浏览器。
Cloudflare 的代理 OAuth 安全指南要求把上游 state 的哈希绑定到安全 cookie，并在 callback 同时
校验 KV 和 cookie。OAuth 2.1 也指出，承载应用状态的 `state` 应绑定 browser session，或进行
签名/加密，避免 swapping。([Cloudflare state handling](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#state-handling),
[OAuth 2.1 CSRF](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-7.9))

最小修复：复用一个 `__Host-RUNNER_GITHUB_STATE` cookie 保存 state 哈希；callback 验证后同时删除
KV record 和 cookie。不要引入 session framework。

### P1：没有拒绝按钮和标准 `access_denied` redirect

页面只有继续按钮。用户可以关闭页面，但 client 得不到终态。OAuth 2.1 定义用户拒绝时应把
`error=access_denied`、原 `state`，以及适用的 `iss` 返回已经验证的 client redirect URI。
([OAuth 2.1 authorization errors](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-4.1.2.1))
Provider 0.10.3 给出了相同的 `iss`-aware redirect 示例。([Cloudflare provider 0.10.3](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md#authorization-response-issuer))

最小修复：同一个 form 增加 `Allow` 和 `Cancel` 两个 submit 值。Cancel 不访问 GitHub，直接用已
解析和保存的 `authRequest.redirectUri` 构造 `access_denied` redirect。

### P1：安全可重定向的 parse errors 被错误地变成本地纯文本 400

当前 `authorizePage()` 捕获所有 `parseAuthRequest()` 错误并返回本地 400。Provider 0.10.3 的
`AuthorizationError` 区分两类错误：没有可信 redirect URI 时必须本地显示；已有经过精确校验的
`redirectUri` 时可以把错误、原 state 和 issuer 返回 client。当前实现不会产生 open redirect，
但会让 ChatGPT 只能等待或显示模糊连接错误。([Cloudflare error handling](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md#authorization-endpoint))

最小修复：只捕获 `AuthorizationError`。依据其 `redirectUri` 选择本地错误或标准 OAuth error
redirect；未知异常继续抛出。

### P1：上游 GitHub web flow 未使用 PKCE

MCP client 到 Worker 的 PKCE 已由 provider 强制 S256，但 Worker 到 GitHub 是另一个独立 OAuth
flow。当前 GitHub URL 和 token exchange 没有 `code_challenge` / `code_verifier`。GitHub 对 GitHub
App web flow 强烈建议 S256 PKCE。([GitHub web flow parameters](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token))

最小修复：生成 verifier，把 verifier 只放进 10 分钟 KV state record；authorization URL 发送
S256 challenge，token exchange 发送 verifier。不要把 verifier 放进 URL 或 cookie。

### P1：scope 文案不足以支持知情授权

当前页面直接显示 `tasks:read, tasks:run, ...`。这符合机器 scope 值，但普通用户无法知道
`repos:write` 是否会直接推送、创建分支或 PR。OpenAI 要求工具声明准确 scope，以便 consent screen
准确，但 UI 如何解释仍由 authorization server 负责。([OpenAI auth UI](https://developers.openai.com/apps-sdk/build/auth#triggering-authentication-ui))

最小修复：保留 canonical scope 值，同时给每个值写固定的一行本地说明；显示 client name、产品名
和一句“GitHub 授权只用于确认身份和仓库访问”。不要从远端 metadata 接受 HTML。

### P1：`analyze` 任务也静态要求 repository write scope

当前 `submit_task` 的 tool security scheme 固定要求 `tasks:run`、`repos:read`、`repos:write` 和
`pull_requests:write`。但是同一个工具同时支持只读 `analyze` mode。授权页即使把这些 scope 解释得
更清楚，也不能让只读任务获得真正的最小权限。

这不是 CSS 或 consent component 可以解决的问题。可选方向是按 operation 做 incremental scope / step-up
authorization，或者把只读提交与写入提交拆成不同 permission surface。MCP 2026-07-28 支持在
`insufficient_scope` 时发起 step-up；具体采用哪个方向应由产品工具边界决定，不应为了页面美观而
暗中扩大权限。([MCP scope selection](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#scope-selection-strategy))

### P2：响应卫生和视觉质量

- consent、callback error 和 success 页面增加 `Cache-Control: no-store`、
  `Referrer-Policy: no-referrer`；
- consent POST 后清除 CSRF cookie；
- 授权成功页使用同一静态模板，明确“可以返回 ChatGPT”；
- 把 scope 排成可读列表，并区分 read、run、cancel、repository write；
- 对可访问性补充 focus、对比度和按钮语义。

这些修改提升隐私和体验，但不应引入 client-side JavaScript。

## 是否有标准 library 可以替代

| 层 | 当前/可选 library | 能解决什么 | 能否替代自制 consent 页 | 建议 |
| --- | --- | --- | --- | --- |
| MCP authorization server | `@cloudflare/workers-oauth-provider@0.10.3` | OAuth/MCP discovery、CIMD/DCR、PKCE、code/token/refresh/revoke、audience、storage | 否；官方设计要求应用提供 consent 和用户认证 | **继续使用并固定版本** |
| GitHub App API 与上游 OAuth | GitHub 官方 `octokit` / `@octokit/app` | App JWT、installation token、GitHub API、user token 交换和刷新 | 否；只处理 GitHub 侧协议 | 可选；当前调用面很小，不为“页面好看”引入 |
| UI framework | React、Hono JSX、Kumo 等 | 模板、样式、组件 | 不能提供 OAuth 授权策略或消除 confused deputy | 不需要 |
| 托管 identity provider | Auth0、Stytch 等 | 完整 AS、登录、hosted consent、管理和审计 | 可以替代大部分自建 AS，但仍要设计 GitHub repository authority | 当前单产品场景不推荐 |

OpenAI 明确建议生产系统优先采用成熟 identity provider，而不是从零实现认证。
([OpenAI choosing an identity provider](https://developers.openai.com/apps-sdk/build/auth#choosing-an-identity-provider))
但是本项目并非从零实现 OAuth：最危险的协议部分已交给 Cloudflare provider；自制部分是一个
GitHub federation adapter 和 consent policy。改用 Auth0 等会新增 tenant、secret、callback、
token exchange 或 GitHub social connection，并不能消除 GitHub App installation 权限检查。对于
当前单一 Worker，这不是 KISS。

GitHub 官方推荐 Octokit.js 处理 GitHub API，并且 `App` client 包含 GitHub App、installation 和
OAuth 能力。([Octokit App client](https://github.com/octokit/octokit.js#app-client))
但当前 Worker 只调用少量稳定 endpoint，已有定向测试。引入 Octokit 的合理触发条件应是 GitHub
调用继续增长、需要 webhook 或需要统一 token cache，而不是为了替换 consent HTML。

## Radical-KISS 推荐

保持三层边界：

```text
ChatGPT / MCP client
  -> workers-oauth-provider 0.10.3      标准 OAuth/MCP 协议
  -> 纯 HTML consent form              本项目 scope 决策
  -> GitHub-hosted authorization page  GitHub 用户身份与 App 权限
```

建议只做一个小型 `authorization-ui.js` 模块：

- 一个 `renderConsent()`；
- 一个 `oauthErrorRedirect()`；
- 一个 `securityHeaders()`；
- 固定 scope-to-description map；
- 让只读 `analyze` 不再静态依赖 repository write scope；
- 两个 POST action：allow / cancel；
- 同一套一次性 browser-bound state helper 用于 consent 和 GitHub callback；
- 上游 GitHub S256 PKCE。

不要做这些事：

- 不要跳过本地 consent，直接依赖 GitHub cached authorization；
- 不要用 GitHub App 安装页替代 MCP scope consent；
- 不要为了样式引入 SPA、React 或新的 session store；
- 不要用一套 generic OAuth library 替换当前 provider；
- 不要删除 DCR 兼容入口。MCP 2026-07-28 优先 CIMD，但 DCR 仍为兼容能力。
  ([MCP authorization overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#overview),
  [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/))

## 最终判断

用户看到“很简陋”是准确的，但问题不是“没有使用 UI library”。真正差距是：授权页缺少强制的
clickjacking 防护，上游 state 未绑定 browser session，以及拒绝、错误 redirect 和上游 PKCE
未形成完整闭环。

最优方向是**保留现有 Cloudflare OAuth provider 和 GitHub App 架构，用约百行静态 Worker 代码把
consent 边界做完整**。这比引入第二个 authorization server 或前端框架更小、更清楚，也更容易审计。
