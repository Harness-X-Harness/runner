# 安全策略与威胁模型

本仓库公开 workflow 和 local actions。真实基础设施、私有仓库身份和凭证必须保存在仓库外。安全性依赖最小权限、受保护默认分支、固定 GitHub Environment 和 Headscale policy，不依赖源码保密。

## 信任边界

`private-runner-session.yml` 创建一次性 GitHub-hosted Ubuntu runner。它可以：

- Headscale 可用时，通过 Tailscale SSH 为可信管理员提供可选私有 shell；
- 运行 Codex、Grok Build 和 T3 Code；
- 通过 Cloudflare Quick Tunnel 提供带 T3 应用层认证的临时入口；
- 通过 GitHub OIDC 认领一个精确 Environment run；
- 通过一个出站 WebSocket 运行多个 Agent Sessions。

runner 会在 job 结束后销毁，但它不是进程级沙箱。用户代码、Agent、T3 和取得 SSH 访问权的主体都以 runner 用户权限运行，并可以读取该 run 中用户可读的文件、provider 配置和临时凭证。

所有合入受保护分支并由受信任 workflow 运行的 `.github/` 和 `apps/` 代码都在同一生产信任边界内。

## MCP 与 GitHub 身份

固定 Worker `https://runners.trustedtunnel.app` 是 MCP、OAuth 和状态控制面。它公开三类 Harness scope：

```text
environments:manage
sessions:manage
tasks:manage
```

Worker consent 与 GitHub App 用户授权是两个独立边界。consent 必须校验 client、redirect URI 和 canonical resource，允许显式拒绝，并使用 `frame-ancestors 'none'`、`no-store` 和 `no-referrer`。GitHub 授权使用 S256 PKCE 和同时绑定浏览器 cookie 的一次性 state。

GitHub 返回用户 token 后，Worker 只派生一个限于 `Harness-X-Harness/runner` 和 `Actions: write` 的 scoped user token。OAuth grant 不保留 base access token，只保留 refresh token、scoped token、到期时间、Principal、Harness scopes 和 MCP controller identity。

控制面 workflow 授权中禁止出现：

- App JWT 或 installation token；
- PAT 或 GitHub OAuth `repo` scope；
- 平台代用户 clone、commit、push 或创建 PR；
- target repository installation continuation；
- 未授权、宽权限或匿名 fallback。

交互式 Environment 用户如需 issue、代码、PR 或 workflow 权限，应在环境内通过 GitHub 官方浏览器或 device flow 登录 `gh`、Git 或 GitHub MCP。Harness 可以传输交互请求，但不能取得、存储或刷新该凭证。

## Autonomous Task 边界

`run-task.yml` 只接收 opaque task_id，使用受保护默认分支的可信 runtime。Task claim 验证 GitHub OIDC 签名、issuer、canonical audience、repository、workflow/ref、ref_protected、actor_id、run ID 和 attempt。取消先于领取时不得释放 prompt；一个 Task 只接纳一个执行身份。

Task Agent 使用 Repository Secret `AGENT_GITHUB_TOKEN`，以 `GH_TOKEN` 注入执行步骤。这是固定平台身份，不是 MCP 用户的目标仓库授权，也不是控制面 token 的 fallback。取得 Task 权限和 runner 调度权限的可信用户，可以让 Agent 使用该固定身份的全部已配置权限。不得把它描述为逐用户目标仓库隔离。

模型 secrets 和 Agent PAT 只进入执行步骤；claim/finish 不接收它们。原生 Agent 子进程去除 Actions OIDC request URL/token 及 job GITHUB_TOKEN，但相同 runner 用户下的进程并非安全隔离。Task 不使用 T3、Tailscale 或 WebSocket；没有平台 clone/commit/PR 流水线。

Task prompt 只在私有状态和 0600 handoff 文件中传递，终态提交时从 Worker 状态删除。最终文本经过共享长度边界，只有 owner 能读取；七天后清理结果、元数据和 alarm。状态和回传不得写普通日志、summary 或 artifacts。MCP 只公开 Task snapshot，不公开 owner、prompt 字段、原生 ID 或 credentials。最终语义文本由 Agent 产生，不代表业务目标已被平台验证。

## 状态与控制通道

一个 GitHub Principal 对应一个 `EnvironmentObject`。它串行化 Environment generation、精确 GitHub run、Agent Sessions、controller、命令和事件 cursor。

Environment workflow 在读取 executor credential、加入 Tailscale 或启动 T3 前，必须通过 GitHub OIDC admission。Worker 同时验证 audience、repository、workflow ref、run ID 和 run attempt。旧 generation 不能连接、回调、发送事件或恢复 Session。

runner 只发起出站 WebSocket。GitHub OIDC token 只在 WebSocket subprotocol 握手中出现，不进入后续消息。durable command ID 提供幂等 native effect；event cursor 提供有序重连。连接断开时 Queue 可以持久化，Steer 必须拒绝。

Agent Session 输出只保留以下 bounded 语义：

- 用户可见文本；
- bounded activity；
- turn 生命周期；
- 声明过的 approval、question 或 authorization request；
- 用户可见错误。

Session Events 不得保留或返回 raw reasoning、thought、完整 stdout/stderr、native payload、provider endpoint、prompt、credential 或 T3 descriptor。

## Widget 与私有流

Session Widget 是 consumer 和 command surface，不是 authority。所有写操作必须调用相同 MCP tools。

单 Session tool result 可以在私有 `_meta` 中携带十分钟加密 stream capability。它必须绑定 owner、Session 和 Grant，并只通过 `Authorization: Bearer` 发送到 `/session-stream/<session_id>`。它不得进入 structured content、text、URL、日志、artifact 或 durable event。过期后，Widget 通过 `read_session` 获取新 capability。takeover 后旧 Grant 不能再执行写操作。

## 凭证与配置

Remote Development Environment 固定使用受保护的 `session--none` GitHub Environment。

| 配置 | 范围 | 用途 |
| --- | --- | --- |
| `HEADSCALE_AUTHKEY` | optional `session--none` Environment secret | tagged ephemeral auth key |
| `HEADSCALE_URL` | optional repository secret | Headscale control server |
| `MINI_END_USER_KEY` | repository secret | Codex 与 Grok 共用 scoped bearer key |
| `MINI_CODEX_BASE_URL` | repository secret | 私有 Codex provider endpoint |
| `MINI_GROK_BASE_URL` | repository secret | 私有 Grok provider endpoint |
| `AGENT_GITHUB_TOKEN` | repository secret，仅 Task Agent step | 固定身份的目标仓库权限，映射到 GH_TOKEN |
| `GITHUB_APP_CLIENT_ID` | Worker variable | GitHub App user authorization |
| `GITHUB_APP_CLIENT_SECRET` | Worker secret | code exchange、refresh、token scoping |
| `ENVIRONMENT_SESSION_SECRET` | Worker secret | Environment browser state 与 Session stream capability |

Codex 与 Grok 在默认 user home 中使用各自原生 `config.toml`，并通过 `env_key = "MINI_END_USER_KEY"` 读取 key。不得把 key 写入 config，不得提交 endpoint，不得增加 login 文件或其他 credential fallback。

## 网络与 T3

runner 会 best-effort 尝试通过 Headscale 加入 tailnet；失败只移除可选的管理员 Tailscale SSH，不影响 T3、Environment Control Channel 或 Agent Sessions。workflow 不启动 OpenSSH。Headscale policy 应默认拒绝，只允许可信管理员连接 tagged runner 的 TCP 22，不允许 runner 横向访问管理设备或内部网络。Tailscale hostname 不进入 Environment Ready descriptor。

Quick Tunnel URL 是公网地址，不是认证凭证。访问控制依赖 T3 pairing/session。workflow 不持有 Cloudflare tunnel token、DNS 权限或长期 tunnel credential。

workflow 等待 Quick Tunnel URL，再调用 T3 原生 `auth pairing create --base-url`。连接信息只写入 runner 上 mode-`0600` 文件和 owner-scoped state。不得进入 MCP 结果、Actions log、summary、artifact、issue 或 PR。

## 供应链

外部 GitHub Actions 固定完整 commit SHA。一次性环境有意使用官方当前入口：Codex standalone installer、Grok Build installer、Tailscale official Action、cloudflared official release 和 `npx --yes t3@latest`。这是 happy-path，不是可复现工具链。

## 发布前检查

```text
[ ] workflow 只由 workflow_dispatch 触发
[ ] 外部 Actions 固定完整 SHA
[ ] admission 早于 credential、Tailscale 和 T3
[ ] Tailscale 失败不阻断 T3 或 Session runtime
[ ] 默认分支与 session--none 均受保护
[ ] Headscale policy 不允许横向访问
[ ] pairing material 不进入 MCP、日志、summary 或 artifact
[ ] Task 使用 tasks:manage，旧 Session/Environment scope 不隐式升级
[ ] GitHub 用户授权仍使用 S256 PKCE 和 browser-bound one-time state
[ ] scoped user token 只限 runner repository 与 Actions write
[ ] 控制面没有 App JWT、installation token、PAT、repo scope 或 fallback
[ ] Task Agent PAT 只注入执行步骤，子进程不继承 OIDC request authority
[ ] Task prompt 在终态删除，结果保留七天，普通日志没有私有 payload
[ ] Session output 不包含 reasoning、raw log、prompt、provider endpoint 或 credential
[ ] Widget capability 只在私有 _meta，短期且绑定 owner/Session/Grant
[ ] GitHub Actions 仍是 Environment lifecycle authority
```

## 报告安全问题

不要在公开 issue、PR 或讨论中提交真实凭证、私有仓库内容、内部地址、完整日志或可利用细节。优先使用 GitHub Private Vulnerability Reporting。发现凭证泄漏时，应先撤销和轮换。
