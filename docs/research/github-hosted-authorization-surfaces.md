# GitHub 托管授权页面与 Harness consent UI

> 历史研究：`tasks:*`、`repos:*` 和 `pull_requests:*` 示例属于已经删除的 Code Task consent。GitHub 提供托管授权页但不提供可嵌入 consent 组件的结论仍有效。

研究日期：2026-08-16

状态：研究结论。本文不改变当前实现。

## 精确问题

GitHub 是否提供可以直接嵌入 Harness X Harness Task Runner 的官方授权页面组件？GitHub OAuth
App、GitHub App 用户授权和 GitHub App installation 的托管页面分别签发什么权限？它们能否显示或
授权 `tasks:read`、`tasks:run` 等 Harness 自有 scope？Primer 是否提供专用 consent 组件？当前
ChatGPT OAuth、GitHub 用户身份和仓库 installation 的组合，怎样保持最简单且不误导用户？

## 结论

**GitHub 提供三类托管授权流程，但没有提供可嵌入第三方网站的通用 consent 页面组件。** 官方
集成方式是把浏览器重定向到 GitHub URL。GitHub 托管页面只处理 GitHub 自己的授权域：

- OAuth App 的 GitHub OAuth scopes；
- GitHub App 的 account、repository 和 organization permissions；
- GitHub App installation 的账户、组织和仓库选择。

`tasks:read`、`tasks:run`、`tasks:cancel`、`repos:*` 和 `pull_requests:write` 是 Harness
authorization server 的 scope。GitHub 不定义这些值，也不签发 Harness access token。因此，GitHub
托管页面不能替代当前 [`/authorize`](../../apps/chatgpt-app/src/authorization.js) consent 页。

Primer 是 GitHub 的公开设计系统。它提供 Button、FormControl、Dialog、ConfirmationDialog 等通用
组件，但公开 catalog 和 UI-pattern index 没有专用 OAuth/consent component。Primer 官方也明确把
React components 定位为 presentational components；它们不负责 API 数据提交。由此可以判断：Primer
可以改善外观和可访问性，但不能接管授权决策或协议行为。([Primer component catalog](https://primer.style/product/components/),
[Primer UI patterns](https://primer.style/product/ui-patterns/),
[Primer React philosophy](https://www.primer.style/product/getting-started/react/philosophy/))

本次还检查了 [`primer/react`](https://github.com/primer/react) 和
[`primer/design`](https://github.com/primer/design) 的完整、未截断公开 source tree，并搜索
`auth`、`authorization`、`consent` 和 `permission` 路径；没有发现可发布的专用 component 或
template。这个结果只证明公开 Primer surface，不推断 GitHub 内部没有私有实现。

## 三类 GitHub 托管页面

| 流程 | 官方入口 | 用户授予什么 | 回到应用的位置 | 能否授权 Harness scopes |
| --- | --- | --- | --- | --- |
| GitHub OAuth App web flow | `https://github.com/login/oauth/authorize` | GitHub 预定义 OAuth scope 所限制的用户权限 | OAuth App callback URL | 否 |
| GitHub App user authorization | 同一个 `/login/oauth/authorize`，但使用 GitHub App client ID | GitHub App 的 account permissions；生成代表用户和 App 的 user access token | GitHub App callback URL | 否 |
| GitHub App installation / update | `https://github.com/apps/APP-NAME/installations/new` 或现有 installation 的 `html_url` | App 的 repository/organization permissions，以及 all/selected repositories | setup URL，或安装时 OAuth callback | 否 |

### GitHub OAuth App 页面

OAuth App 把用户重定向到 `GET https://github.com/login/oauth/authorize`。GitHub 托管授权页面显示
应用请求的 GitHub OAuth scopes。GitHub 文档只定义其“Available scopes”集合，例如 `repo`、
`user:email` 和 `gist`。这些 scope 限制 GitHub token 可以访问的 GitHub 数据，不能表达第三方服务
内部的任务权限。([OAuth web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow),
[GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps))

GitHub 文档还说明，OAuth App 用户可以少授予一些请求的 GitHub scope，应用必须处理功能减少的
情况。这个行为只适用于 GitHub token，不会生成 Harness token，也不会向 ChatGPT 授予 Harness
scope。([Requested and granted OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#requested-scopes-and-granted-scopes))

本项目不需要再创建一个独立 GitHub OAuth App。GitHub 明确优先推荐 GitHub App，因为它使用更细的
权限、可限制仓库，并使用短期 token。当前 GitHub App 已能执行 user authorization web flow。
([GitHub Apps and OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps))

### GitHub App 用户授权页面

GitHub App 也使用 `https://github.com/login/oauth/authorize` 获得 user access token。这个 token
**不使用 OAuth scopes**；GitHub 的 token response 中 `scope` 始终为空。其有效权限是 App 权限和
用户权限的交集，其资源范围还受 App installation 限制。
([GitHub App user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#about-user-access-tokens),
[web application flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token))

因此，这个托管页面适合当前项目的“确认 GitHub 用户身份”步骤。它不能读取 Harness 的
`authRequest.scope`，也不能向 ChatGPT 发出 Harness authorization code。Harness 必须在自己的
authorization server 中完成这个决策。

GitHub App 的 account permissions 在用户授权时批准。repository 和 organization permissions 在
installation 时批准。GitHub 官方把 authorization 与 installation 明确分开，并允许只做其中一个。
([Installation and authorization difference](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party#difference-between-installation-and-authorization),
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#about-github-app-permissions))

### GitHub App installation 页面

GitHub 托管 installation 页面让用户选择个人账户或组织、选择全部或部分仓库，并审查 App 请求的
repository 和 organization permissions。没有安装权限的组织成员可以向组织 owner 发出安装请求。
([Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party#installing-a-github-app),
[Requesting an installation](https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner))

这正是当前 [`startInstallationAuthorization()`](../../apps/chatgpt-app/src/repository-authorization.js)
应继续使用的页面。只有目标仓库缺少 installation 或权限不足时，才需要把用户送到该页面。

installation 完成后，GitHub 可以重定向到 App 的 setup URL。GitHub 警告：setup URL 中的
`installation_id` 可以被伪造，应用不能直接相信它；应用必须用已认证用户重新验证 installation
归属。([GitHub App setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url))

## GitHub 是否提供“标准授权组件”

在本次检查的 GitHub 官方文档中，公开契约是托管 URL、callback URL、setup URL 和协议参数。没有
文档提供 iframe、Web Component、React component 或可在第三方域名中复用的 GitHub authorization
form。这个边界合理：只有 GitHub 域名上的页面可以可信地代表 GitHub 签发权限。

GitHub 允许 App owner 定制托管页面上的 App badge：上传 logo 并选择 badge 背景色。这是改善
GitHub 页面识别度的官方入口，不需要复制 GitHub 页面。
([GitHub App custom badge](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/creating-a-custom-badge-for-your-github-app),
[OAuth App custom badge](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-a-custom-badge-for-your-oauth-app))

### Primer 能做什么

Primer 的公开 component catalog 是通用 UI building blocks，不是 GitHub 授权服务。Primer React 的
标准安装至少引入 `@primer/react`、`@primer/primitives`、`react` 和 `react-dom`，并要求
ThemeProvider/BaseStyles。([Primer React setup](https://primer.style/product/getting-started/react/))

Primer CSS 可以单独安装，但其官方仓库已处于 KTLO 模式，并建议完整 pattern 使用 Primer React 或
ViewComponents。([Primer CSS official repository](https://github.com/primer/css))

对当前无 JavaScript、单表单的 Worker 页面，引入 React、客户端 bundle 或完整 Primer CSS，只为
接近 GitHub 外观，会增加依赖和构建面，却不增加授权正确性。更重要的是，过度复制 GitHub 外观会
模糊授权主体：当前页面授予的是 Harness 权限，不是 GitHub 权限。

因此，Primer 的合理用途只有两种：

1. 把 Primer 的公开 layout、focus、contrast 和 form guidance 当设计参考；
2. 如果未来整个控制面已经使用 React，再复用通用 Primer components。

当前不应只为一个 consent form 引入它。

## 对当前双层 OAuth 的关键影响

当前用户实际经过两个授权域、最多三个界面：

```text
ChatGPT
  -> Harness consent                授予 Harness MCP scopes
  -> GitHub App user authorization  确认用户并授予 GitHub account permissions
  -> GitHub App installation        仅在目标仓库缺少访问时授予仓库权限
```

这不是重复授权。每一层控制不同的主体和资源：

- ChatGPT 是否可以调用 Harness 的任务能力；
- Harness 是否知道当前 GitHub 用户，并可按用户身份检查权限；
- GitHub App 是否能访问指定 owner/repository。

GitHub 的托管页面只能替代后两项的 UI，不能替代第一项。

ChatGPT 手工连接会聚合所有工具声明的 scope。最简单的一致行为是：Harness consent 页准确显示并
授予客户端本次请求的 Harness scopes；仓库访问仍由后续按需 GitHub App installation 限制。
[`consentScopes()`](../../apps/chatgpt-app/src/oauth-scopes.js) 只验证、去重和固定排序，不静默缩减
客户端请求。否则客户端请求六项但 authorization server 只签发一项时，ChatGPT 会正确报告
“not all requested permissions were granted”。改用 GitHub 页面不能消除这个差异，因为 GitHub 不
签发这些 scope。

如果产品必须在首次连接时只授予 `tasks:read`，则客户端必须只请求 `tasks:read`，后续再发起明确的
增量授权。服务端单方面缩小 scope 会保留“不完整连接”提示，不是 UI library 可以修复的问题。

## Radical-KISS 建议

1. **保留一个 GitHub App，不增加独立 GitHub OAuth App。** 用同一个 App 的 user authorization
   获取用户身份，用 installation access 管理仓库。
2. **保留 Harness 自有 consent 页。** 它只显示 Harness scopes，并明确写出授权主体是 ChatGPT
   client 与 Harness control plane。
3. **使用 GitHub 托管 user authorization。** 按钮写清“Continue with GitHub”，不在 Harness 页面
   自行复制 GitHub 的 account permission UI。
4. **保持 repository installation 懒触发。** 只有任务目标仓库缺少 installation 或权限时，才跳转
   GitHub 托管 installation/update 页面。
5. **修正 scope 行为，不靠页面掩盖差异。** 对客户端请求给出完整同意或标准拒绝；不要静默部分
   授权。如果要 step-up，先确保客户端确实只请求 baseline scope。
6. **只优化小型静态 HTML。** 使用清晰层级、产品 badge、权限说明、主次按钮和现有安全 header；
   不引入 React/Primer runtime。
7. **在 GitHub App 设置中上传正式 badge。** 这是 GitHub 托管授权和 installation 页面的一致品牌
   来源。

## 当前实现边界

本项目继续使用
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) 处理
MCP/OAuth discovery、CIMD、DCR、PKCE、authorization code、token、refresh、revocation 和 resource
audience。这个 provider 把用户认证和 consent 策略留给应用，因此它不会提供可替代 Harness 页面的
通用 UI。

Harness consent 保持为无 JavaScript 的静态表单。授权请求先经过 provider 校验；页面 state 与浏览器
绑定并存入强一致的 Durable Object；拒绝返回标准 `access_denied`；继续操作使用 S256 PKCE 跳转
GitHub；CSP 只允许本站、已验证的客户端 redirect origin 和固定 GitHub OAuth origin。这个边界不需要
React、Primer runtime 或第二个 authorization server。

最终边界应保持简单：**Harness 页面解释并授予 Harness 权限；GitHub 页面解释并授予 GitHub
权限。不要让任一页面假装能够代表另一个 authorization server。**
