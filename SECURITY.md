# 安全策略与威胁模型

本仓库公开 workflow 和 local actions。真实凭证、provider endpoint 和私有任务内容保存在公开源码之外。安全性依赖受保护默认分支、精确执行身份和授权边界，不依赖源码保密。

## 身份与授权

固定 Worker `https://runners.trustedtunnel.app` 提供 MCP、OAuth、Environment 和 Task 状态。访问需要 `environments:use`；其他 scope 不授予 Environment 权限。

必须区分三种身份：

- Harness Principal：稳定 GitHub 用户 ID，拥有 Environment 和 Task。
- Execution identity：GitHub OIDC 签发的精确 repository、workflow/ref、actor、run ID 和 attempt。
- Agent GitHub identity：Repository Secret `AGENT_GITHUB_TOKEN` 对应的固定身份，通过 `GH_TOKEN` 注入 Agent。

MCP consent 校验 client、redirect URI 和 canonical resource，允许拒绝，并使用 `frame-ancestors 'none'`、`no-store` 和 `no-referrer`。GitHub 授权使用 S256 PKCE 和浏览器绑定的一次性 state。

Worker 从 GitHub App 用户 token 派生仅限 Execution Repository 和 `Actions: write` 的 scoped token。只有该用户权限能 dispatch、observe、cancel。OAuth grant 保留 refresh/scoped token 和到期时间，不保留 base access token。没有 App JWT、installation token、PAT、OAuth `repo` scope 或另一平台身份作为控制面 fallback。

Agent 使用固定 GitHub token 的全部已配置目标权限，不按提交者的目标仓库权限过滤。只有可信用户可以获得 Task 访问权。撤销用户的控制面授权，不等于立即撤销已经开始执行的 Agent PAT；GitHub 的 job limit 仍约束 runner 生命周期。

## 一次性 runner 的信任边界

`run-environment.yml` 只接收 opaque Environment ID。它 checkout 可信 runtime，关闭 checkout credential persistence，在获取 executor secrets 前通过 OIDC 领取环境，然后安装选定 CLI 并建立绑定到精确执行的连接。Agent 和直接命令共享工作区，每个 Environment 同时只允许一个操作。仓库、issue、代码和 PR 操作不是平台固定流水线。

runner 不是进程级沙箱。Agent、用户代码和工具以相同 runner 用户运行，可以读取该用户可读的文件和凭证。模型 secrets 和 Agent PAT 只进入执行步骤；claim/finish 不接收它们。原生子进程不直接继承 Actions OIDC request URL/token 或 job `GITHUB_TOKEN`，但这不构成相同用户下的进程隔离。

合入受保护分支并由可信 workflow 执行的 `.github/`、`apps/` 和 `shared/` 代码均在生产信任边界内。不得把可以运行任意恶意代码并持有可复用凭证的主机描述为隔离的多租户沙箱。

## Environment 状态与输出

Environment 及其操作按 Principal 检查所有权；ID 和 Resource URI 不是凭据。同一 Principal 的不同 grant 可以访问同一环境，但每次操作与订阅交付仍须有效授权。旧 scope 不升级为 `environments:use`。

运行时连接绑定精确 GitHub run/attempt、runtime identity 和递增 generation。断线不证明进程已停止，旧 generation 不能提交新状态。关闭须确认执行终止和容量释放，取消不能回滚外部副作用。相同 runner 用户下 Agent 与 command 不是隔离边界。

输出 Resource 只交付有界用户可见文本，不转发 reasoning、原生 RPC 或 metadata。命令输出和 Agent 回复是用户数据，不能保证任意文本绝不包含秘密；平台不得主动写入凭据。关闭环境退出 live discovery，已知结果保留七天，到期后读取拒绝且不能重新执行。

操作请求（包括 prompt、命令参数和原生问题回答）保存在 Environment 的私有状态中，不在操作终态时删除。请求随操作记录保留到环境确认关闭后七天，由到期 alarm 清理。保留原请求用于核对同一提交键的重试，不能把结果保留等同于仅保留输出。MCP 状态和输出投影不包含私有请求或原生会话标识。

工作区文件位于临时 runner，不属于上述结果保留范围。关闭环境会失去这些文件，包括已保存和只在本地提交的内容；需要保留的内容必须先推送或另存到外部。

## MCP Events 出站通知

Events 与工具共用认证和 `environments:use`，订阅只属于一个 Principal 的一个 Environment。
后台仅保存 provider 的 grant identity，不保存短期 Bearer。每次投递用 provider 公开 API
复核 grant/client、scope 和到期，并检查结果保留边界。OAuth KV 具有最终一致性，不能承诺即时撤销；
取消后的延迟验证或旧投递响应不能恢复订阅，已经发出的 HTTP 请求不能撤回。

callback 和签名 secret 只保存在私有 Environment 状态中，不进入 MCP 结果或日志。正式 Worker
不增加公网投递路由；私有 Node Container 每次检查全部 DNS 回答，固定已验证公网 IP，并用
原 hostname 验证 TLS，拒绝私网、保留地址和重定向。验证 challenge 与实际事件使用相同出站规则。
Standard Webhooks 签名覆盖实际发送字节；刷新密钥后在一分钟内双签。通知只含 ID、revision 和
生命周期状态，不含用户正文、输出或连接凭证。订阅和待投递队列有界，不建立历史事件数据库。

## 凭证与供应链

配置入口见 [workflow](.github/workflows/run-environment.yml)、[Worker 配置](apps/chatgpt-app/wrangler.jsonc) 和 [部署说明](docs/runner-operations-runbook.md#deployment-credentials)，不在此维护第二份变量清单。

Codex/Grok 使用默认 home 的原生 config，并通过 `env_key = "MINI_END_USER_KEY"` 读取 key。endpoint 来自 GitHub Secrets。外部 Actions 固定完整 commit SHA；CLI 使用官方当前 installer。这是 happy-path，不是可复现工具链。两条 auth workflow 的输出必须丢弃，不能变成公开诊断日志。

本地 `.secrets.env`、`.lark.env` 和私有运维配置必须保持 Git 忽略。

## 发布前检查

- 新工作仅使用 `environments:use`，旧 scope 不自动升级。
- 用户 GitHub 权限与固定 Agent GitHub 权限分开。
- OIDC 精确身份验证先于私有 prompt 和执行凭证释放。
- 操作请求和结果保留到环境确认关闭后七天，到期清理，终态不可复活。
- 私有输入、输出和 secrets 不进入普通日志、summary 或 artifacts。
- 本地测试、workflow lint 和改动边界的真实验收均通过。
- 存储删除必须精确指定类；删除数据不能通过回退源码恢复。

## 报告安全问题

不要在公开 issue、PR 或讨论中提交真实凭证、私有仓库内容、内部地址、完整日志或可利用细节。优先使用 GitHub Private Vulnerability Reporting。发现凭证泄漏时，应先撤销和轮换。
