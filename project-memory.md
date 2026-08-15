# Project memory

本文档保存跨模块、可复用且已经验证的项目事实，并作为专项文档的索引。事实保持被发现或确认时
使用的语言；不要为了统一语言而翻译。易变的验收状态、操作细节和架构说明留在对应专项文档中。

这里不是工作日志。不得写入聊天流水、完整命令输出、秘密值、私钥、OAuth token、prompt 或未经
验证的猜测。

## 文档索引

- [ChatGPT code-task app](docs/chatgpt-app.md)：控制面、OAuth、GitHub App 与部署配置。
- [ADR 0001](docs/adr/0001-oauth-kv-task-durable-objects.md)：OAuth KV 与 task Durable Object 的存储边界及重新评审条件。
- [ChatGPT app acceptance memory](docs/chatgpt-app-acceptance.md)：当前验收状态和未完成的外部验证。
- [Runner operations runbook](docs/runner-operations-runbook.md)：临时 runner 的操作与验证。
- [Lark session card](docs/lark-reporting.md)：Lark webhook、可更新卡片与连接信息。
- [Security](SECURITY.md)：凭证边界、威胁模型和安全检查表。

## 已验证事实

证据最近复核于 2026-08-15；条目中另有说明时以条目边界为准。

| 事实 | 证据与适用边界 | 对实现或验收的影响 |
| --- | --- | --- |
| The canonical product brand is `Harness X Harness Task Runner`; both occurrences of `Harness` are required. | The owner confirmed the exact display name on 2026-08-15. Machine identifiers use `harness-x-harness-task-runner`, and the control-plane Worker uses `harness-x-harness-task-runner-control-plane`. | UI text, MCP identity, User-Agent, GitHub App name and bot slug, Worker name, URLs, workflow authorship, tests, and documentation must preserve the full brand. |
| Runner repository is owned by the `Harness-X-Harness` GitHub Organization. | On 2026-08-15, `GET /repos/Harness-X-Harness/runner` returned organization ownership, and the authenticated `ronhuafeng` membership was active with organization role `admin` and repository permission `ADMIN`. This evidence applies only to the current authenticated session. | The current session can manage repository environments, secrets, variables, and settings. Organization policy and GitHub App installation access remain separate authorization gates. |
| `Harness X Harness Task Runner` is owned by and installed on the `Harness-X-Harness` organization. | On 2026-08-15, an App JWT identified the exact App name and slug `harness-x-harness-task-runner`; repository installation lookup succeeded for `Harness-X-Harness/runner`. The active installation selects all organization repositories and grants `Actions`, `Contents`, and `Pull requests: write` plus `Metadata: read`. | The control plane can resolve an installation token for the runner repository. Workflow dispatch through the branded Worker remains a separate end-to-end acceptance gate. |
| 一个 GitHub App 可以同时承担用户授权和 installation 身份，不需要额外创建传统 GitHub OAuth App。 | Worker 使用 GitHub App client credentials 完成 user-to-server authorization code exchange；`github.js` 使用 App JWT 创建 installation token。测试覆盖两条路径，并拒绝 `GITHUB_OAUTH_*` 配置。 | 保持一个 App registration，不引入传统 OAuth App 的宽泛 `repo` scope。 |
| GitHub App installation ID 属于具体 installation，可以通过 runner 仓库自动解析。 | `github.js` 先调用 `GET /repos/{owner}/{repo}/installation`，再使用返回的 ID 调用 `POST /app/installations/{id}/access_tokens`；production-edge test 验证了该请求序列。 | 不要求操作者复制或持久保存 installation ID。 |
| GitHub user access token 与 installation token 职责不同。 | 授权路径保存并刷新 user token，用于检查用户对目标仓库的访问权；workflow dispatch 使用短期 installation token。两条路径由不同测试覆盖。 | 两类凭证不能互相替代，也不能出现在 MCP 输出中。 |
| GitHub REST API 请求必须显式携带有效的 `User-Agent`；Cloudflare Worker 的默认 `fetch` 行为不能当作这个应用层契约。 | 部署版本缺少该请求头时，GitHub authorization-code exchange 成功，但随后的 `GET /user` 返回 403 HTML；代码无条件按 JSON 解析时抛出未捕获异常，形成 Worker 1101，且尚未进入 grant 创建。统一增加应用专用 `User-Agent` 后，同一生产流程成功完成 profile 查询、OAuth grant、token exchange 和 MCP initialize。GitHub OAuth token endpoint 不属于这个 REST 请求边界。 | 所有 user token、App JWT 和 installation token 发起的 `api.github.com` 请求统一使用 `githubHeaders()`；新增 GitHub REST 调用不得手写不完整的 header 集合。 |
| `@cloudflare/workers-oauth-provider` 0.8.2 的授权码和 token 使用冒号分隔，并要求解析后恰好三段，因此应用传入的 OAuth `userId` 不能包含冒号。 | 上游固定版本源码使用 `<userId>:<grantId>:<secret>` 并通过 `split(":")` 校验三段；生产验证使用 `github-<id>` 后成功完成 authorization-code exchange。 | GitHub OAuth subject 使用 `github-<id>`，不能恢复为 `github:<id>`；引入其他 identity provider 时也必须使用分隔符安全的 subject。 |
| GitHub Actions 自定义 secret 名不能以 `GITHUB_` 开头。 | Repository secret API 对 `GITHUB_APP_ID` 返回 HTTP 422，并明确说明该前缀被保留；workflow 契约测试拒绝 `secrets.GITHUB_*`。 | Worker 可以继续使用 `GITHUB_APP_*` 绑定，但 runner repository 必须使用 `RUNNER_GITHUB_APP_ID` 与 `RUNNER_GITHUB_APP_PRIVATE_KEY`。 |
| JavaScript Action 的 `INPUT_*` 环境变量保留 input 名中的连字符；不能自行把连字符改成下划线。 | 生产 run `30196554687` 的 workflow 显示 `control-plane-url` 与 `task-id` 均有值，但 action 查找 `INPUT_CONTROL_PLANE_URL` 和 `INPUT_TASK_ID` 后得到空字符串，构造出 `/internal/tasks//events`；使用实际 `INPUT_CONTROL-PLANE-URL`、`INPUT_TASK-ID` 启动 action 进程的回归测试复现并验证修复。 | 依赖外部 action runtime 注入的环境变量时按 runtime 的原生键名读取；此 action 的 input helper 只做大写转换，保留连字符。 |
| 固定版本的 `openai/codex-action` 中，`allow-bots` 只信任 `github-actions[bot]`；自定义 GitHub App actor 必须通过 `allow-bot-users` 精确列出。 | 已检查当前固定 SHA 的 Action 权限判断源码，并通过 App JWT 确认当前 App slug；workflow 契约测试固定了对应的 `<app-slug>[bot]`。 | Worker 使用 App installation token dispatch workflow 时，不能只配置 `allow-bots: true`，否则 Codex 会在 actor 权限检查阶段被拒绝。 |
| Cloudflare user API token 与 account API token 使用不同的验证入口。 | 已验证并记录在 [ChatGPT code-task app](docs/chatgpt-app.md)：`cfut_` 使用 `/user/tokens/verify`，`cfat_` 使用 `/accounts/{account_id}/tokens/verify`。 | 错误 ownership endpoint 返回的 `401` 不能证明 token 无效；`active` 也不能证明 token 具备部署所需的全部权限。 |
| 当前本地 Cloudflare 部署只需要一个 `CLOUDFLARE_API_TOKEN`。 | Worker/KV 部署均使用 Wrangler 的标准 token 变量；仓库没有 Billing、D1、Access 或 route-profile API 调用，Cloudflare 也建议部署过程持续使用同一个具备所需权限的 token。 | `.secrets.env` 不按 Cloudflare API 拆分 token；`CLOUDFLARE_ACCOUNT_ID` 只是目标账户标识。自定义域名或新增 Cloudflare 产品时重新评审权限。 |
| OAuth 与 task 使用不同存储是有意的边界，不是为了统一技术栈而遗漏 D1。 | 当前 `@cloudflare/workers-oauth-provider` 要求 `OAUTH_KV`，并负责 token hash、grant props 加密、过期和撤销；task 则由每 task 一个 Durable Object 串行处理 callback、取消和结果更新。权衡记录在 [ADR 0001](docs/adr/0001-oauth-kv-task-durable-objects.md)。 | 当前不需要 D1 权限。只有出现立即全局撤销、关系型授权查询、完整审计报表，或上游提供事务型 storage adapter 时才重新评审。 |
| Cloudflare account API can enumerate Durable Object namespaces and object IDs, but it does not expose the stored task contents. | The production API listed two `TaskObject` instances with stored data; the documented object response contains only `id` and `hasStoredData`. In this application, task content is read through a Worker binding and is protected by either user OAuth on MCP tools or GitHub Actions OIDC on internal callbacks. | A Cloudflare deployment token cannot be treated as an administrative task-read credential. Production acceptance of task status/result requires evidence from the authorized MCP route or the OIDC callback path. |
| 本地 GitHub App 私钥文件 `*.private-key.pem` 已被忽略。 | `git check-ignore` 将本地私钥文件匹配到仓库 `.gitignore` 规则；未读取私钥内容。 | 私钥不得进入 tracked files、文档、日志、summary 或 artifact。 |
