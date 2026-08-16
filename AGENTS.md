# AGENTS.md

## Agent skills

### Issue tracker

Issues and PRDs live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Engineering skills use the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

### Live stories

Human-in-the-loop production acceptance for the Private Development
Environment is defined in
`docs/agents/live-stories/private-development-environment.md`. Use it after a
merged change affects that user story; do not convert it into CI automation.

## 事实经验自动固化

每个 clone 在 Agent 开始工作时必须初始化本地工作记忆：先确认 `.agent-memory/` 已写入该
clone 的 `.git/info/exclude`，再创建缺失的 `.agent-memory/` 目录、
`.agent-memory/project-memory.md` 和 `.agent-memory/chatgpt-app-acceptance.md`。新文件只建立最小
标题和结构，不虚构历史事实。该目录不得加入 Git、不得提交，也不得从其他 clone 复制未经验证
的状态。

诊断、验证、评审和实现过程中，默认自动把可复用的事实经验写回本地 `.agent-memory/`，不等待
用户再次提醒。它不是工作日志：不得复制聊天流水、完整命令输出或尚未验证的猜测。

出现以下任一信号时，建立一个 fact-memory checkpoint：

- 用户纠正推翻了现有假设、文档或操作方式；
- 真实硬件、系统 API、外部工具或测试暴露了稳定行为、前置条件、副作用或失败模式；
- 同一摩擦重复出现，或某个上层 gate 被未证明的底层事实阻塞；
- 代码行为与归属文档不一致；
- acceptance 状态从未测试变为通过、失败、部分通过或阻塞。

在继续下一层工作或结束当前任务前，agent 自动执行：

1. **验证**：用最近的代码、测试、系统事实或原始证据复核；不能复核的内容标记为推论或未决，
   不写成既定规则。
2. **分类**：区分可复用平台事实、产品约束、验收结论、一次性工具故障和真正的架构决策。
3. **归属**：跨模块稳定事实和文档索引写入 `.agent-memory/project-memory.md`；易变验收状态写入
   `.agent-memory/chatgpt-app-acceptance.md` 或最近的本地 memory 文件。公开 architecture、
   operations、ADR、README 和 SECURITY 只保存当前有效的产品契约，不保存迁移、故障调查、
   run ID 或阶段验收历史。
4. **写入**：记录事实、证据环境、适用边界、未证明内容和对实现/验收的影响。使用匿名占位符
   或脱敏摘要引用本地 artifacts，不复制敏感原始数据。事实记忆保持被发现或确认时使用的
   语言，不为了统一文档语言而翻译。
5. **消歧**：搜索并删除或修正同范围内已经过时、相互矛盾的表述；不要同时保留新旧两套指导。
6. **验证文档**：至少运行 `git diff --check`，检查链接、命令和脱敏；文档改变可执行契约时运行
   对应的轻量测试。

自动固化的授权仅限当前仓库的本地 `.agent-memory/`，以及与已验证事实直接相关的现行公开契约
修正。以下情况必须先询问：

- 将经验提升为同时约束三个项目的本文件规则；
- 修改全局 instruction、skill、模板或仓库外知识库；
- 创建或改变难以逆转且不直观的 ADR；
- 事实仍有多个会改变产品方向的合理解释；
- 写入需要公开敏感信息。

一次性 shell 转义、授权窗口、进程信号或工具可用性问题，只有在可复现且会改变项目 harness
设计时才固化；否则只在当前任务结果中说明。完成时简要报告更新了哪些本地项目记忆，以及哪些
结论因证据不足没有提升。

## 完成后的系统快照

每次完成一个阶段或任务后，最终回复必须重新总结：

- **系统状态**：按组件区分已验证通过、已配置但未验证、配置缺失、人工授权阻塞和失败；
- **本次变化**：代码、配置、外部系统和项目记忆分别发生了什么变化；
- **后续工作**：按依赖顺序列出下一步，并明确哪些可以自动执行、哪些必须由用户操作；
- **交付状态**：是否已提交、推送、部署、触发 workflow，是否留下后台进程或临时资源。

不得沿用已经被本次执行改变的旧状态，也不得把静态检查通过表述为端到端验证通过。
