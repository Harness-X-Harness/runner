# 安全策略与威胁模型

本仓库公开 workflow 和 local actions。真实基础设施、私有仓库身份和凭证必须保存在仓库外。安全性依赖最小权限凭证、受保护的默认分支、固定 GitHub Environment 和 Headscale policy，而不是源码保密。

## 信任边界

本项目通过 `workflow_dispatch` 创建一次性的 GitHub-hosted Ubuntu runner。它可以：

- 通过 Headscale/Tailscale SSH 提供私有 shell；
- 运行 Codex、Claude Code 和 T3 Code；
- 通过 Cloudflare Quick Tunnel 暴露带 T3 应用层认证的临时公网入口；
- 通过 GitHub OIDC 向认证后的 Environment 入口发布一次 ready descriptor。

GitHub-hosted runner 会在 job 结束后销毁，但这不是进程级沙箱。用户在环境中运行的代码、开发工具、T3 Code 和取得 SSH 访问权的主体均以 runner 用户权限运行，并能访问当前 run 中该用户可读的文件与凭证。

任何合并到受保护分支、随后由受信任 Environment dispatch 的 workflow 或 local action 都处于同一信任边界。必须像审查生产部署代码一样审查 `.github/`、`apps/`、`headscale/` 和安全配置。

ChatGPT code-task app 另有一个固定在
`https://runners.trustedtunnel.app` 的 Cloudflare Worker 控制面。Worker
通过 OAuth 2.1 + PKCE 识别用户，把完整 prompt 保存在按 task ID 分片的
Durable Object 中，并只向 GitHub Actions workflow 传递 task ID、仓库、ref、
executor 和 mode。workflow 使用 GitHub Actions OIDC 访问一次性 callback
接口；MCP 返回值只允许包含任务的非敏感元数据（任务 ID、仓库、ref、executor、mode、状态、时间和 run ID）、结果摘要、commit 和 PR URL。Worker
的 GitHub App 私钥、GitHub App client secret、目标仓库授权 token、prompt 和
OIDC token 不得进入 workflow inputs、MCP structured content、日志、summary
或 artifact。`TASK_CONTROL_PLANE_URL` 必须同时配置在 Worker 和 runner
repository variables 中，并作为 OIDC audience 精确匹配。

Worker 自己的 MCP consent 页与 GitHub 托管的 App 授权页是两个不同的授权
边界。consent 页必须先校验 client 和精确 redirect URI，解释固定 scope，允许
显式拒绝，并使用 `frame-ancestors 'none'`、`no-store` 和 `no-referrer`。Worker
到 GitHub 的 user authorization flow 使用独立的 S256 PKCE；一次性 state 同时
绑定短期 KV record 和发起流程的安全浏览器 cookie。callback 必须同时验证两者，
再消费 state。`analyze` 只要求 task run 和 repository read scope；写入 mode 在
`submit_task` 是一个含 `analyze`、`edit` 和 `pull_request` 参数的单一 MCP tool。
由于 tool `securitySchemes` 是静态契约，它必须声明这三个 mode 可能使用的完整 scope
集合；不得依赖参数级动态授权升级。初始 MCP challenge 和 protected-resource
metadata 同样发布完整 App scope 集合。服务器仍按实际 mode 校验最小 scope，授权
服务器也只授予客户端实际请求且经过校验的 scope。

Repository authorization 在 dispatch 前只选择一个路径。公开仓库的
`analyze` 使用 `public_read`；私有读取和所有写入使用经过用户授权与 App JWT
复核的 installation。GitHub API 未知响应、installation 缺失或权限不足不得
降级到另一条路径，也不得回退到 PAT。缺少 installation 时，task 保持
`awaiting_installation`，公开输出只包含一个 opaque Worker authorization URL
和所需权限名称。

GitHub 安装返回的 `installation_id` 和通知本身不是授权证据。Worker 必须重新
验证原提交用户、目标仓库和当前 installation permissions；Durable Object 再以
原子 claim 保证一个 task 最多 dispatch 一次。安装 state 不包含 prompt、token
或 private key，并在 KV 中限时保存。

## 凭证与固定 GitHub Environment

Remote Development Environment workflow 固定使用受保护的 `session--none`
GitHub Environment。它只接收控制面签发的不透明 `environment_id`，不接收目标仓库或用户指令。

| 配置 | 建议范围 | 用途 |
| --- | --- | --- |
| `HEADSCALE_AUTHKEY` | `session--none` Environment secret | tagged ephemeral auth key |
| `HEADSCALE_URL` | Repository secret | Headscale control server URL |
| `GITHUB_APP_ID` | Worker secret | 调度 workflow 的 GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret | 调度 workflow 的 GitHub App 私钥 |
| `RUNNER_GITHUB_APP_ID` | Runner repository secret | 目标仓库授权使用的同一个 GitHub App；避开 GitHub 保留的 `GITHUB_` secret 前缀 |
| `RUNNER_GITHUB_APP_PRIVATE_KEY` | Runner repository secret | 目标仓库授权使用的 GitHub App 私钥；只注入 token 创建 Action |
| `GITHUB_APP_CLIENT_SECRET` | Worker secret | GitHub App user-to-server 授权与 token 刷新 |
| `ENVIRONMENT_SESSION_SECRET` | Worker secret | 签名 Environment 浏览器会话与 opaque generation |
| `MINI_END_USER_KEY` | Runner repository secret | Codex 与 Grok 共用的 scoped bearer key；只通过环境变量或 Action secret input 注入 |
| `MINI_CODEX_BASE_URL` | Runner repository secret | Codex provider base URL；不得写入仓库、日志或 artifact |
| `MINI_GROK_BASE_URL` | Runner repository secret | Grok provider base URL；不得写入仓库、日志或 artifact |
| `ANTHROPIC_API_KEY` | Runner repository secret | Claude Code executor，仅在对应步骤注入 |

`session--none` 只允许受保护默认分支部署。workflow 不保存目标仓库 token，也不自动 clone；用户在临时环境中自行建立的 Git、GitHub 或其他凭证属于该 run 的完整用户信任边界，并在 run 结束时销毁。

`MINI_END_USER_KEY` 同时具有 Codex 与 Grok provider scope。两个 provider
endpoint 是机密配置。Codex 与 Grok 在默认用户 home 中使用各自原生
`config.toml`，并通过 `env_key = "MINI_END_USER_KEY"` 读取同一把 key。不得把
key 写入 config，不得提交 provider endpoint，也不得为 Grok 配置 first-party
login、`auth.json` 或 `XAI_API_KEY` fallback。独立 auth workflows 使用官方当前
安装器和原生 user config 执行最小模型请求，并丢弃模型输出；它们不自行模拟
provider 的认证协议。

Environment ready callback 使用 GitHub Actions OIDC。Worker 必须同时验证
audience、repository、workflow ref 和精确 run ID；opaque generation 只用于把
回调路由到原 GitHub 用户，不替代 OIDC authority。

## 网络边界

runner 始终通过 Headscale 加入 tailnet 并使用 Tailscale SSH；workflow 不启动系统 OpenSSH 服务，也不接收 SSH public key。客户端使用：

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Headscale policy 应默认拒绝，只允许管理端身份连接 `tag:gha-runner` 的 TCP 22，并仅允许对应的 Tailscale SSH 登录。不要允许 runner 主动访问管理员设备、内部服务或宽泛 subnet routes。示例 policy 需要按实际身份、tag 和部署版本调整。

Cloudflare Quick Tunnel URL 是公网可达地址，不是秘密或认证凭据。访问控制依赖 T3 自身的 pairing/session authentication。workflow 不持有 Cloudflare 账户 token、DNS 权限、长期 tunnel credential 或稳定 hostname。

## T3 session 数据

workflow 先等待 Quick Tunnel URL，再通过 T3 原生 `auth pairing create --base-url` 命令为该 public origin 签发 pairing URL。workflow 不解析 credential，不自行拼接 URL，也不从 `serve` 日志复用 loopback pairing URL。

连接信息写入 runner 上 `~/private-runner-session` 下的 mode-`0600` 文件，不写入 Actions step summary。全部连接就绪后，OIDC callback 将 descriptor 写入 owner 专属 Durable Object。认证后的稳定 Environment 入口只在 ready 状态重定向到原生 pairing URL。

不要把 pairing URL、连接文件、Git credential、内部地址或包含私有仓库信息的日志上传为 artifact，也不要粘贴到聊天、公开 issue 或 pull request。连接是否仍有效以 GitHub Actions run 状态为准。

## Fork 与 pull request

Fork 不会继承上游的 repository/Environment secrets、Environment 审批规则、分支保护、Headscale 节点或私有仓库权限。来自 fork 的 pull request 也不会因为仓库源码而自动取得这些 secrets。

风险发生在修改后的代码被合并并在受信任 Environment 中再次 dispatch 时。应至少启用：

- 所有变更通过 pull request；
- Code Owner 审批，并保证 owner 具有 write 权限；
- 新提交撤销过期批准；
- 禁止 force push 和宽泛 bypass；
- 对 `.github/`、`apps/` 和 `headscale/` 的变更进行安全审查。

不要把真实生产凭证复制到不受信任的 fork。测试 fork 时应使用独立、可撤销、最小权限的测试凭证。

## 供应链策略

外部 GitHub Actions 固定到完整 commit SHA。运行时工具刻意遵循一次性开发环境的当前上游入口：

- Private Development Environment 的 Codex、Claude Code 和 Grok Build 使用各自官方安装器；
- ChatGPT code-task 的 Codex 使用官方 CLI 安装器；
- ChatGPT code-task 的 Claude Code 使用官方安装器；
- ChatGPT code-task 的 Grok Build 使用 xAI 官方 CLI 安装器；
- Tailscale 使用官方 Linux 安装器；
- cloudflared 使用 Cloudflare 官方软件源；
- T3 Code 使用 `npx --yes t3@latest`。

这套环境有意优先采用官方最新入口，而不是构建可复现工具链，因此工具版本会随上游变化。审查 workflow 变更时，也应复核安装来源和上游入口是否仍为官方推荐方式。

## 发布前检查

```text
[ ] workflow 仍只由 workflow_dispatch 触发
[ ] 未加入 pull_request_target、issue_comment 或特权 workflow_run 路径
[ ] 外部 GitHub Actions 固定到完整 SHA
[ ] 默认分支和固定 `session--none` Environment 均受保护
[ ] `session--none` 只允许受保护默认分支部署
[ ] Headscale grants 不允许 runner 横向访问
[ ] Quick Tunnel 仍依赖 T3 应用层认证
[ ] pairing URL 只进入 mode-0600 runner 文件和认证后的 Environment state，不进入 MCP、日志、summary 或 artifact
[ ] 官方工具安装入口已经复核
[ ] ChatGPT Worker 的 OAuth KV、GitHub App client ID 和控制面 URL 已配置
[ ] Worker 只绑定 `runners.trustedtunnel.app`，且 `workers.dev` 和 Preview URLs 已关闭
[ ] GitHub App 已安装到 `GITHUB_RUNNER_REPOSITORY`，且 Worker 可自动解析 installation
[ ] Worker 与 runner repository 的 `TASK_CONTROL_PLANE_URL` 完全一致
[ ] MCP 返回值未包含 prompt、OAuth token、App private key 或 OIDC token
[ ] consent 页仍有拒绝路径、clickjacking 防护和人类可读 scope 说明
[ ] GitHub user authorization 仍使用 S256 PKCE 和 browser-bound one-time state
[ ] analyze 的 OAuth scope 不包含 repository 或 pull-request write
[ ] public_read 只允许公开仓库 analyze，不允许任何写入 mode
[ ] installation callback 重新验证原用户和仓库权限，不信任 installation_id
[ ] repository access 失败不会触发匿名、PAT、retry 或其他 fallback
```

## 报告安全问题

不要在公开 issue、pull request 或讨论中提交真实凭证、私有仓库内容、内部地址、完整日志或可利用细节。优先使用 GitHub Private Vulnerability Reporting（若已启用）；否则私下联系维护者。发现凭证泄漏时，应先撤销和轮换凭证。
