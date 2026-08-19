# MCP 与 GitHub 授权页面的边界

> 历史研究：授权边界分析仍有参考价值，但 legacy Task scope 和 installation-token execution 已删除。当前 MCP scope 只有 `sessions:manage` 和 `environments:manage`。

研究日期：2026-08-18

状态：研究结论。本文不修改实现、部署或外部配置。

## 精确问题

当前 Harness MCP authorization server 是否可以让浏览器不显示
`https://runners.trustedtunnel.app/authorize` 页面，直接进入 GitHub 的
`https://github.com/login/oauth/authorize`？传统 GitHub OAuth App 的授权页能否让用户选择精确的
repository 和 permission？如果不能，哪种 GitHub 授权模型满足这个要求？当前项目怎样做才同时保持
协议正确和 Radical KISS？

## 结论

1. **浏览器可以不显示 Harness 页面，但 OAuth 流程不能绕过 Harness authorization endpoint。**
   ChatGPT 必须先把 MCP authorization request 发给 Harness 公布的 endpoint。该 endpoint 可以完成
   请求校验、state/PKCE 绑定和策略判断后立即返回 `302` 到 GitHub。这样用户看到的第一个网页是
   GitHub，但网络流程仍短暂经过 Harness。
2. **不能把 MCP metadata 的 `authorization_endpoint` 直接改成 GitHub URL。** GitHub 只签发 GitHub
   token。它不会签发带 Harness audience 和 `environments:manage`、`tasks:*` 等 Harness scope 的
   MCP token，也不会替 Harness 完成 ChatGPT client registration、resource binding 和最终 callback。
3. **传统 GitHub OAuth App 的 `repo` scope 不支持按 repository 精确选择，也不是细粒度 permission。**
   它对该用户可访问的 public/private repositories 提供宽泛的 repository 能力；用户在 OAuth 页面对
   scope 作批准或缩减，不会得到 `Only select repositories` 选择器。
4. **GitHub App installation 是 Web App 场景下 GitHub 原生的精确模型。** App owner 预先声明细粒度
   repository permissions；安装者选择 `All repositories` 或 `Only select repositories`。如果还要求
   “以真实用户身份执行”，GitHub App user access token 的实际权限是用户权限、App permission 和
   installation repository 集合的交集。
5. **必须先决定哪个约束更重要。** “只用传统 OAuth App”与“在 GitHub 页面精确选择 repository 和
   permission”不能同时成立。页面重排或参数调整不能修复这个产品模型冲突。

## 1. `/authorize` 能否直接跳转 GitHub

### 协议角色不能合并

MCP 规定，受保护 MCP server 是 resource server，ChatGPT 等 host 是 OAuth client，authorization
server 负责在需要时与用户交互并签发 MCP access token。MCP server 通过 protected resource metadata
公布 authorization server；客户端再读取 authorization server metadata 中的
`authorization_endpoint` 和 `token_endpoint`。([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization))

OpenAI 对 ChatGPT 的契约相同：ChatGPT 对 MCP authorization server 执行 authorization-code + S256
PKCE，授权后把该 server 签发的 token 放入后续 MCP 请求。MCP server 必须检查 issuer、audience、
expiry 和 scope；GitHub token 不能代替这个 MCP token。([OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth))

所以以下替换不成立：

```text
authorization_endpoint = https://github.com/login/oauth/authorize
token_endpoint         = https://github.com/login/oauth/access_token
```

GitHub 不认识 ChatGPT 的 CIMD/DCR client，不签发 Harness scopes，也不会把 token 绑定到
`https://runners.trustedtunnel.app/mcp` resource。即使能完成 GitHub code exchange，ChatGPT 得到的也
不是可由 Harness 按 MCP 契约验证的 access token。

### 可以移除“可见中转页”

传统 GitHub OAuth web flow 本来就是“应用把用户重定向到 GitHub，GitHub 再重定向回应用”。GitHub
明确要求应用维护 `state`，并推荐使用 S256 PKCE。([GitHub OAuth web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow))

因此 Harness `/authorize` 可以：

```text
ChatGPT
  -> GET Harness /authorize       校验 client、redirect_uri、resource、scope、PKCE
  <- 302 GitHub /login/oauth/authorize
  -> GitHub callback at Harness   交换 GitHub code、确认用户
  -> completeAuthorization()      签发 Harness code
  -> ChatGPT callback
```

这会消除一个用户可见页面，但不会消除 Harness endpoint 或其 state。直接把原 MCP request 参数透传给
GitHub 也不正确；Harness 必须保存并绑定两层 OAuth 的 state，不能把 ChatGPT redirect URI 交给
GitHub。

### 什么时候仍需要 Harness scope consent

GitHub 页面只能显示 `repo` 等 GitHub scopes。它不能显示或批准 `environments:manage`、`tasks:run`
等 Harness scopes。MCP 当前规范要求客户端按最小权限请求 scope，并把 authorization server 和终端
用户的 consent 作为 scope 选择过程的一部分。OpenAI 也要求 tool 的 OAuth security scheme 准确声明
scope，并描述用户在连接时对请求 scope 进行 consent。([MCP scope selection](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-selection-strategy),
[OpenAI tool authentication](https://developers.openai.com/apps-sdk/build/auth#oauth-flow))

“需要 consent”不等于“每次必须显示 Harness HTML”。Authorization server 可以基于已经存在的 grant
或明确的管理策略不再询问，但不能把 GitHub 对 `repo` 的批准错误地当成 Harness scope consent。
MCP 的 proxy security guidance 还明确警告：当 MCP server 用固定上游 client ID 代理第三方 OAuth 时，
对动态下游 client 必须取得用户 consent，避免 confused-deputy 问题。([MCP 2025-06-18 security considerations](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#security-considerations))

对当前系统，协议正确的页面策略是：

- 已被平台明确预批准的 client、scope 集合：`/authorize` 可以立即 `302` 到 GitHub；
- 首次出现的 client、扩大的 Harness scopes、DCR client 或无法证明已有 consent 的请求：保留 Harness
  consent，或明确拒绝；
- 不要对任意 client 自动授予全部 Harness scopes。

如果产品只服务一个组织控制的固定 ChatGPT client，并把固定 scope 授权写成管理策略，则直接跳转是
可辩护的 KISS 实现。如果还要开放 VS Code 和任意 MCP client，就不能把“省一页”升级为全局
auto-consent。

## 2. 传统 GitHub OAuth App 能否精确选择 repository 和 permission

不能。

GitHub 对传统 OAuth App 的定义是：scope 限制 token 的**能力类别**，但 token 仍以用户身份访问该用户
可访问的资源。GitHub 的比较文档明确说明，授权 OAuth App 会让 App 访问用户可访问的资源；相比之下，
GitHub App installation 才限制到账户选择的 repositories。([GitHub Apps and OAuth Apps comparison](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps#what-can-github-apps-and-oauth-apps-access))

`repo` 不是“只允许一个 repo”。它是 GitHub 官方定义的宽 scope，包含 public/private repository code、
commit status、deployment、invitation、collaborator 和 webhook 等能力，并附带部分 organization-owned
resources 的能力。([GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes))

用户可以减少请求的 OAuth scopes，但 scope 仍是 `repo`、`read:org` 等粗粒度类别。GitHub OAuth
authorization endpoint 没有 repository selection 参数。传统 OAuth App 页面也没有 GitHub App 安装页
的 `Only select repositories` 控件。

当前 Environment control plane 需要 dispatch private repository workflow。GitHub 对该 endpoint 的
官方要求正好说明差异：传统 OAuth token 需要粗粒度 `repo` scope；GitHub App user/installation token
或 fine-grained PAT 只需目标 repository 的 `Actions: write` permission。([Create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event))

## 3. 哪种 GitHub 模型支持精确 repository 和 permission

### 推荐：GitHub App

GitHub App 有两层原生限制：

1. App owner 在 App registration 中声明最小 repository、organization 和 account permissions；
2. 安装者选择 `All repositories` 或 `Only select repositories`，并审查 App 声明的 permissions。

([Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[Installing a GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party#installing-a-github-app))

要以用户身份执行，可以使用 GitHub App user access token。它不使用传统 OAuth scopes；有效权限是用户
自身权限和 App permissions 的交集，有效资源还是用户可访问资源与 App installation repositories 的
交集。([GitHub App user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#about-user-access-tokens))

要减少 GitHub 自己的两步体验，GitHub App 支持
`Request user authorization (OAuth) during installation`：安装后 GitHub 立即继续 user authorization
flow。这仍不替代 Harness MCP scope consent，但可把 repository selection 和 GitHub 用户授权合并成
一个连续的 GitHub 托管流程。([GitHub authorization during installation](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#requesting-user-authorization-oauth-during-installation))

注意：安装者选择 repository；permission 集合由 App owner 预先声明。安装者不是在每次登录时任意
组合 permission。如果 App 更新并增加 permission，现有安装需要重新批准。

### 现有 GitHub App 的更小迁移路径：scoped user access token

GitHub API `POST /applications/{client_id}/token/scoped` 可以把一个 non-scoped GitHub App user
access token 换成 repository-scoped 和 permission-scoped user access token。请求可以固定
`repository_ids`，并把 `permissions` 降到 `actions: write`。该 endpoint 使用 App client ID 和
client secret 做 Basic authentication；它不能把 token 扩权到 App 或用户本来没有的资源。
([Create a scoped access token](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token))

这为当前迁移提供了一个比“再注册一个 App”更小的 capability boundary：继续使用现有 GitHub App
完成一次用户授权，保留 non-scoped token 给尚未删除的 legacy Code Task，同时为 Environment 派生一个
只含 `Harness-X-Harness/runner` 和 `Actions: write` 的 scoped user token。Environment adapter 只接受
后者，且不回退到 installation token 或 non-scoped user token。

这不是 GitHub 授权页中的用户 repository selector。repository 和 permission 由 Harness 在 token
exchange 后固定收窄；如果产品要求安装者必须在 GitHub UI 亲自选择 repository，则仍要创建并安装专用
GitHub App。若产品要求的是实际 capability 最小化，scoped user token 已提供同等的 Environment token
边界，并避免第二个 App 和第二次用户授权。

### 可精确但不适合作为正常 App 连接：fine-grained PAT

Fine-grained PAT 创建页允许用户选择 resource owner、repositories 和具体 repository/organization/
account permissions。([Managing fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token))

但是它不是 OAuth App authorization redirect 的输出。用户需要自行创建并把 secret 交给 Harness，组织
也可能要求审批。它适合高级 BYOC credential 模式，不是当前 ChatGPT connection 的最简默认路径。

## 4. 对当前项目的最简修正建议

### 先修正文案和产品事实

当前实现请求传统 OAuth App 的 `repo` scope。页面和文档必须明确：

- 它授予 Harness 以该用户身份访问该用户可访问 repositories 的宽 GitHub scope；
- 它不是“只授权 Execution Repository”；
- GitHub OAuth App 页面不能让用户选择单个 repository 或细粒度 permission。

如果仍采用 OAuth App，不应设计一个假的 repository selector；服务端自己只访问固定 runner repo 是
应用策略，不是 GitHub token 的 capability boundary。

### 页面路径

最短且协议正确的路径是：

```text
已批准的固定 MCP client + 未扩大的 Harness scopes
  -> Harness /authorize 内部校验并保存 state
  -> 立即 302 GitHub OAuth

其他 client 或 scope 扩大
  -> Harness consent
  -> GitHub OAuth
```

这比删除 `/authorize` 正确，也比每次重复展示相同 consent 更短。实现必须用明确 client allowlist 或
已保存 consent 判断，不要依据可伪造的 `clientName`。

### GitHub 授权模型

这里只有两个诚实的 KISS 选项：

| 优先约束 | 选择 | 必须接受的代价 |
| --- | --- | --- |
| 最少 GitHub UI、以用户身份直接调 workflow | 传统 OAuth App + `repo` | 不能按 repo/permission 精确授权；token 权限较宽 |
| GitHub 原生 repository selection 和最小 permission | GitHub App，固定 `Actions: write`，安装时选 runner repo | 需要 installation；需要处理 user token refresh |
| 保留 legacy Task 且让 Environment token 精确收窄 | 现有 GitHub App + scoped user access token | GitHub UI 不提供 selector；Harness 固定派生 `runner + Actions:write` token |

当前问题同时要求“传统 OAuth App”与“GitHub 页面精确选 repo/permission”。这个组合不存在。由于
Environment control plane 只需要在一个固定 repository 中 dispatch、observe 和 cancel workflow，
**安全边界优先且 legacy Task 仍存在时，最小迁移是复用现有 GitHub App，并为 Environment 派生仅含
runner repository 与 `Actions: write` 的 scoped user token。** Legacy Task 删除后，可以同步把 App
installation 和 registration 权限收窄，或再决定是否值得拆成专用 App。如果产品明确接受传统 OAuth
`repo` 的宽权限，才继续当前 OAuth App 迁移，并删除任何“细粒度选择”的产品承诺。

不要同时让 OAuth App 和 GitHub App 为同一个 Environment 操作提供 fallback。先选择唯一 authority，
再删除被替代的路径；否则用户无法知道哪项授权在生效，测试也无法证明最小权限。

## 最终判断

用户看到 GitHub 作为第一张页面是可实现的：Harness `/authorize` 在后台校验后立即 `302` 即可。但是，
这只优化导航，不能让 GitHub OAuth App 获得它没有的细粒度授权能力。

真正的决策不是“页面放在哪里”，而是：

- 接受传统 OAuth App 的宽 `repo` scope，换取较少 GitHub 安装流程；或
- 使用 GitHub App installation，换取 GitHub 原生 repository selection 和 `Actions: write` 最小权限；
  或从现有 GitHub App user token 派生同样窄的 Environment scoped token。

两者之间没有一个通过 OAuth URL 参数即可获得的折中方案。
