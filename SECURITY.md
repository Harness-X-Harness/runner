# 安全策略与威胁模型

本仓库公开 workflow 和 local actions。真实基础设施、私有仓库身份和凭证必须保存在仓库外。安全性依赖最小权限凭证、受保护的默认分支、GitHub Environment 审批和 Headscale policy，而不是源码保密。

## 信任边界

本项目通过 `workflow_dispatch` 创建一次性的 GitHub-hosted Ubuntu runner。它可以：

- 使用限定到目标仓库的 Git 凭证检出私有代码；
- 通过 Headscale/Tailscale SSH 提供可选的私有 shell；
- 运行 Codex、Claude Code 和 T3 Code；
- 通过 Cloudflare Quick Tunnel 暴露带 T3 应用层认证的临时公网入口；
- 使用 Lark 应用机器人发送并更新一张 session 状态卡片。

GitHub-hosted runner 会在 job 结束后销毁，但这不是进程级沙箱。目标仓库代码、开发工具、T3 Code 和取得 SSH 访问权的主体均以 runner 用户权限运行，并能访问当前 session 中该用户可读的文件与凭证。

任何合并到受保护分支、随后由受信任 Environment dispatch 的 workflow 或 local action 都处于同一信任边界。必须像审查生产部署代码一样审查 `.github/`、`apps/`、`headscale/` 和安全配置。

ChatGPT code-task app 另有一个稳定的 Cloudflare Worker 控制面。Worker
通过 OAuth 2.1 + PKCE 识别用户，把完整 prompt 保存在按 task ID 分片的
Durable Object 中，并只向 GitHub Actions workflow 传递 task ID、仓库、ref、
executor 和 mode。workflow 使用 GitHub Actions OIDC 访问一次性 callback
接口；MCP 返回值只允许包含任务的非敏感元数据（任务 ID、仓库、ref、executor、mode、状态、时间和 run ID）、结果摘要、commit 和 PR URL。Worker
的 GitHub App 私钥、GitHub App client secret、目标仓库授权 token、prompt 和
OIDC token 不得进入 workflow inputs、MCP structured content、日志、summary
或 artifact。`TASK_CONTROL_PLANE_URL` 必须同时配置在 Worker 和 runner
repository variables 中，并作为 OIDC audience 精确匹配。

## 凭证与 GitHub Environment

每个目标仓库应使用独立、受保护的 GitHub Environment。Environment 名称会显示在 Actions UI 中，不得包含敏感信息。

| 配置 | 建议范围 | 用途 |
| --- | --- | --- |
| `TARGET_REPO` | Environment secret | `owner/repository` 格式的目标私有仓库 |
| `TARGET_REPO_AUTH` | Environment secret | 仅可访问该目标仓库的最小权限 token |
| `HEADSCALE_AUTHKEY` | Environment secret | 启用 SSH 时使用的 tagged ephemeral auth key |
| `HEADSCALE_URL` | Repository 或 Environment secret | Headscale control server URL |
| `LARK_APP_ID` | Repository 或 Environment secret | Lark 自建应用 ID |
| `LARK_APP_SECRET` | Repository 或 Environment secret | Lark 自建应用密钥 |
| `LARK_CHAT_NAME` | Repository 或 Environment secret | 机器人所在目标群的精确名称 |
| `GITHUB_APP_ID` | Worker secret | 调度 workflow 的 GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret | 调度 workflow 的 GitHub App 私钥 |
| `RUNNER_GITHUB_APP_ID` | Runner repository secret | 目标仓库授权使用的同一个 GitHub App；避开 GitHub 保留的 `GITHUB_` secret 前缀 |
| `RUNNER_GITHUB_APP_PRIVATE_KEY` | Runner repository secret | 目标仓库授权使用的 GitHub App 私钥；只注入 token 创建 Action |
| `GITHUB_APP_CLIENT_SECRET` | Worker secret | GitHub App user-to-server 授权与 token 刷新 |
| `CODEX_API_KEY` | Runner repository secret | Codex executor 的上游 bearer token，仅传给 Codex Action |
| `CODEX_RESPONSES_API_ENDPOINT` | Runner repository secret | Codex executor 的完整 Responses endpoint，仅传给 Codex Action |
| `ANTHROPIC_API_KEY` | Runner repository secret | Claude Code executor，仅在对应步骤注入 |
| `XAI_API_KEY` | Runner repository secret | Grok Build executor，仅在对应步骤注入 |

应为 Environment 配置 required reviewers、prevent self-review 和只允许受保护默认分支部署的规则。`TARGET_REPO_AUTH` 不得使用组织管理员 token 或具有宽泛仓库权限的 classic PAT。

目标仓库凭证存放在 runner 本地的 path-scoped Git credential store 中。它不会成为全局 Git 凭证，但这不是进程隔离：以 runner 用户运行的目标代码和工具仍可能读取它。

Lark secrets 当前作为 job 环境变量提供，因此 workflow 中的所有步骤和 local action 进程都属于其信任边界。Online 卡片包含 pairing URL，因此目标 Lark 群的所有成员也属于凭证信任边界。仅允许受信任代码进入可访问这些 secrets 的分支与 Environment，并限制目标群成员资格。

## 网络边界

启用 SSH 时，runner 通过 Headscale 加入 tailnet 并使用 Tailscale SSH；workflow 不启动系统 OpenSSH 服务，也不接收 SSH public key。客户端使用：

```bash
tailscale ssh runner@gha-<run-id>-<run-attempt>
```

Headscale policy 应默认拒绝，只允许管理端身份连接 `tag:gha-runner` 的 TCP 22，并仅允许对应的 Tailscale SSH 登录。不要允许 runner 主动访问管理员设备、内部服务或宽泛 subnet routes。示例 policy 需要按实际身份、tag 和部署版本调整。

Cloudflare Quick Tunnel URL 是公网可达地址，不是秘密或认证凭据。访问控制依赖 T3 自身的 pairing/session authentication。workflow 不持有 Cloudflare 账户 token、DNS 权限、长期 tunnel credential 或稳定 hostname。

## T3 session 数据

workflow 原样使用 T3 输出的 pairing URL，不自行拼接、改写 host 或重建 token 路径。若外部配对要求显式 public origin，应使用 T3 上游支持的配置方式。

连接信息写入 runner 上 `~/private-runner-session` 下的 mode-`0600` 文件，不写入 Actions step summary。Online 卡片包含临时 T3 origin 和 pairing URL，并禁止转发；Offline 更新会移除这两个入口。

除配置的 Lark 群外，不要把 pairing URL、连接文件、Git credential、内部地址或包含私有仓库信息的日志上传为 artifact，也不要粘贴到其它聊天、公开 issue 或 pull request。job 被取消或结束时，Lark Action 的原生 `post` hook 会尽力把卡片更新为 Offline；runner 已消失或断网时无法保证该更新。

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

外部 GitHub Actions 固定到完整 commit SHA。ChatGPT code-task 的 Codex
executor 使用固定 SHA 的 OpenAI 官方 Codex Action；未指定
`codex-version`，因此 Action 内安装的 Codex CLI 仍遵循该 Action 的当前默认版本。
其他运行时工具则刻意遵循一次性开发环境的当前上游入口：

- Private T3 Session 的 Codex 和 Claude Code 使用各自官方安装器；
- ChatGPT code-task 的 Claude Code 使用官方安装器；
- Grok Build 使用 xAI 官方 CLI 安装器；
- Tailscale 使用官方 Linux 安装器；
- cloudflared 使用 Cloudflare 官方软件源；
- T3 Code 使用 `npx --yes t3@latest`。

这套环境有意优先采用官方最新入口，而不是构建可复现工具链，因此工具版本会随上游变化。审查 workflow 变更时，也应复核安装来源和上游入口是否仍为官方推荐方式。

## 发布前检查

```text
[ ] workflow 仍只由 workflow_dispatch 触发
[ ] 未加入 pull_request_target、issue_comment 或特权 workflow_run 路径
[ ] 外部 GitHub Actions 固定到完整 SHA
[ ] 默认分支和 session Environment 均受保护
[ ] Environment 启用了 required reviewers 和 prevent self-review
[ ] TARGET_REPO_AUTH 只访问一个目标仓库
[ ] Headscale grants 不允许 runner 横向访问
[ ] Quick Tunnel 仍依赖 T3 应用层认证
[ ] pairing URL 只进入 mode-0600 runner 文件和指定的不可转发 Lark 卡片，不进入日志、summary 或 artifact
[ ] 官方工具安装入口已经复核
[ ] ChatGPT Worker 的 OAuth KV、GitHub App client ID 和控制面 URL 已配置
[ ] GitHub App 已安装到 `GITHUB_RUNNER_REPOSITORY`，且 Worker 可自动解析 installation
[ ] Worker 与 runner repository 的 `TASK_CONTROL_PLANE_URL` 完全一致
[ ] MCP 返回值未包含 prompt、OAuth token、App private key 或 OIDC token
```

## 报告安全问题

不要在公开 issue、pull request 或讨论中提交真实凭证、私有仓库内容、内部地址、完整日志或可利用细节。优先使用 GitHub Private Vulnerability Reporting（若已启用）；否则私下联系维护者。发现凭证泄漏时，应先撤销和轮换凭证。
