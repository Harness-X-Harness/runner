# 安全策略与威胁模型

本仓库公开 workflow 和 local actions。真实凭证、provider endpoint 和私有任务内容保存在公开源码之外。安全性依赖受保护默认分支、精确执行身份和授权边界，不依赖源码保密。

## 身份与授权

固定 Worker `https://runners.trustedtunnel.app` 提供 MCP、OAuth 和 Task 状态。唯一产品 scope 是 `tasks:manage`。

必须区分三种身份：

- Harness Principal：稳定 GitHub 用户 ID，拥有 Task。
- Execution identity：GitHub OIDC 签发的精确 repository、workflow/ref、actor、run ID 和 attempt。
- Agent GitHub identity：Repository Secret `AGENT_GITHUB_TOKEN` 对应的固定身份，通过 `GH_TOKEN` 注入 Agent。

MCP consent 校验 client、redirect URI 和 canonical resource，允许拒绝，并使用 `frame-ancestors 'none'`、`no-store` 和 `no-referrer`。GitHub 授权使用 S256 PKCE 和浏览器绑定的一次性 state。

Worker 从 GitHub App 用户 token 派生仅限 Execution Repository 和 `Actions: write` 的 scoped token。只有该用户权限能 dispatch、observe、cancel。OAuth grant 保留 refresh/scoped token 和到期时间，不保留 base access token。没有 App JWT、installation token、PAT、OAuth `repo` scope 或另一平台身份作为控制面 fallback。

Agent 使用固定 GitHub token 的全部已配置目标权限，不按提交者的目标仓库权限过滤。只有可信用户可以获得 Task 访问权。撤销用户的控制面授权，不等于立即撤销已经开始执行的 Agent PAT；GitHub 的 job limit 仍约束 runner 生命周期。

## 一次性 runner 的信任边界

`run-task.yml` 只接收 opaque Task ID。它 checkout 受保护分支上的可信 runtime，关闭 checkout credential persistence，在获取 executor secrets 前通过 OIDC 领取任务，然后安装选定 CLI 并执行 prompt。仓库、issue、代码和 PR 操作由 Agent 按 prompt 完成，不是平台固定流水线。

runner 不是进程级沙箱。Agent、用户代码和工具以相同 runner 用户运行，可以读取该用户可读的文件和凭证。模型 secrets 和 Agent PAT 只进入执行步骤；claim/finish 不接收它们。原生子进程不直接继承 Actions OIDC request URL/token 或 job `GITHUB_TOKEN`，但这不构成相同用户下的进程隔离。

合入受保护分支并由可信 workflow 执行的 `.github/`、`apps/` 和 `shared/` 代码均在生产信任边界内。不得把可以运行任意恶意代码并持有可复用凭证的主机描述为隔离的多租户沙箱。

## 领取、结果与取消

Task claim 验证 OIDC 签名、issuer、canonical audience、repository、workflow/ref、受保护分支、GitHub-hosted runner、dispatch event、actor 和 run/attempt。一个 Task 最多释放 prompt 给一个已接纳执行。取消先于领取时，后到 claim 不得释放 prompt。

prompt 只在私有状态和 mode-0600 handoff 文件中传递，终态提交时从 Worker 状态删除。最终文本受共享长度限制，只有 owner 能读取；七天后清理结果、元数据和 alarm。Task ID 是查询 handle，不是授权凭证。

回传和日志不记录 prompt、原生协议、reasoning、provider endpoint 或 credential。MCP 公开的是 owner-authorized Task snapshot，不含 owner 字段、prompt 字段、原生 thread/session ID 或 secrets。最终文本由 Agent 产生，因此可信用户也应避免要求 Agent 在结果中披露凭证。

取消是 intent，不是 rollback。终态不可变；完成或失败回传可以先提交。丢失 finish 后，后续有效授权查询可以用精确 GitHub run 证据收敛状态，但不能从日志恢复模型结果。没有永久后台观察者，也不保证用户授权失效后的无人值守收敛。

## 凭证与供应链

配置入口见 [workflow](.github/workflows/run-task.yml)、[Worker 配置](apps/chatgpt-app/wrangler.jsonc) 和 [部署说明](docs/runner-operations-runbook.md#deployment-credentials)，不在此维护第二份变量清单。

Codex/Grok 使用默认 home 的原生 config，并通过 `env_key = "MINI_END_USER_KEY"` 读取 key。endpoint 来自 GitHub Secrets。外部 Actions 固定完整 commit SHA；CLI 使用官方当前 installer。这是 happy-path，不是可复现工具链。两条 auth workflow 的输出必须丢弃，不能变成公开诊断日志。

本地 `.secrets.env`、`.lark.env` 和私有运维配置必须保持 Git 忽略。Lark 不在 Task 执行路径内；其配置不因 Task 退役清理而自动撤销。

## 发布前检查

- Task 只使用 `tasks:manage`，旧 scope 不升级为 Task 权限。
- 用户 GitHub 权限与固定 Agent GitHub 权限分开。
- OIDC 精确身份验证先于私有 prompt 和执行凭证释放。
- prompt 在终态删除，结果保留七天，终态不可复活。
- 私有输入、输出和 secrets 不进入普通日志、summary 或 artifacts。
- 本地测试、workflow lint 和改动边界的真实验收均通过。
- 存储删除必须精确指定类；删除数据不能通过回退源码恢复。

## 报告安全问题

不要在公开 issue、PR 或讨论中提交真实凭证、私有仓库内容、内部地址、完整日志或可利用细节。优先使用 GitHub Private Vulnerability Reporting。发现凭证泄漏时，应先撤销和轮换。
