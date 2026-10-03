import type { Snapshot } from "../ui/view.ts";

export const scenes = [
  { id: "empty", label: "空列表", hint: "选择助手 → 刷新 → 发送指令 → 刷新 → 关闭 → 刷新。" },
  { id: "list", label: "已有工作区", hint: "点击工作区打开卡片。" },
  { id: "opening", label: "启动中", hint: "点击卡片的刷新，取得就绪快照。" },
  { id: "ready", label: "就绪 / 发送", hint: "输入任意指令；返回演示结果，不调用模型。" },
  { id: "working", label: "执行中 / 停止", hint: "查看进度、停止操作，或刷新取得结果。" },
  { id: "question", label: "等待回答", hint: "选择颜色并提交，或拒绝问题，再刷新。" },
  { id: "unsupported-question", label: "在对话中回答", hint: "演示无法在卡片内表达的问题；消息只写入下方记录。" },
  { id: "completed", label: "完成 / 结果", hint: "阅读回复，在下方继续追问或发送下一条指令。" },
  { id: "long-result", label: "长结果", hint: "检查 Markdown 排版、代码和表格滚动及窄屏换行。" },
  { id: "historical", label: "旧结果 + 当前操作", hint: "显示旧结果，但停止按钮应指向当前操作。" },
  { id: "command-failed", label: "命令失败", hint: "检查退出码和标准错误输出。" },
  { id: "failed", label: "Agent 失败", hint: "操作失败不等于工作区关闭。" },
  { id: "cancelled", label: "操作已取消", hint: "仍可发送下一条指令。" },
  { id: "closing", label: "关闭中", hint: "刷新后显示已关闭。" },
  { id: "closed", label: "已关闭 / 保留结果", hint: "不显示未来倒计时，不允许发送或关闭。" },
  { id: "unavailable", label: "连接不可用", hint: "检查不可用说明和关闭入口。" },
  { id: "capacity-owner", label: "已有工作区 / 容量", hint: "点击打开可回到已有工作区。" },
  { id: "capacity-global", label: "全局容量已满", hint: "刷新列表后，可重新选择助手。" },
] as const;
export type SceneId = typeof scenes[number]["id"];
export type Executor = "codex" | "grok";
export type PreviewResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export const environmentId = `env_${"a".repeat(32)}`;
const operationId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
const result = (structuredContent: Record<string, unknown>): PreviewResult => ({ structuredContent, content: [] });
export const rejected = (text: string): PreviewResult => ({ isError: true, content: [{ type: "text", text }] });

const markdownExample = [
  "# 工作区检查摘要", "",
  "这是 **Markdown 排版示例**。正文、标题和列表沿用卡片主题；没有调用模型、GitHub 或 MCP 服务。", "",
  "## 结论", "",
  "- 短回复保持紧凑，长段落自动换行。",
  "- `代码` 使用较小的等宽字体。",
  "- ~~整张卡片横向滚动~~；宽代码和表格只在自身区域滚动。", "",
  "> 这是引用内容。像素风体现在边框和配色，不需要把正文做成低分辨率文字。", "",
  "### 示例代码", "",
  "```typescript",
  'const workspace = "local-preview";',
  `const path = "${"long-path/".repeat(16)}";`,
  "console.log(workspace, path);",
  "```", "",
  "### 检查结果", "",
  "| 组件 | 浅色主题 | 深色主题 | 窄屏布局 | 说明 |",
  "| --- | --- | --- | --- | --- |",
  "| 助手回复 | 同一字阶 | 同一字阶 | 段落换行 | 不替换主题 |",
  "| 代码与表格 | 像素边框 | 像素边框 | 区域滚动 | 不扩大卡片 |", "",
  "- [x] 标题、列表和引用排版",
  "- [ ] 用户视觉评审", "",
  "[Markdown 语法说明](https://commonmark.org/help/)", "",
  "![图片描述示例：不会加载外部图片](https://example.com/preview.png)", "",
  "---", "",
  "## 长内容", "",
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}. 本地布局样例：长段落应自动换行，不扩大卡片宽度。\n\n   ${"long-path/".repeat(16)}`),
].join("\n");

function ready(executor: Executor, now: number): Snapshot {
  return { contract: "ordinary", environmentId, executor, environmentStatus: "ready", disposition: "accepted",
    workFinished: false, expiresAt: now + 6 * 60 * 60_000, idleExpiresAt: now + 15 * 60_000,
    activeOperationId: null, agent: { current: true, state: { uncertain: false, selection: {
      model: executor === "codex" ? "gpt-6-sol" : "grok-4.7", reasoningEffort: executor === "codex" ? "high" : "xhigh",
    } } } };
}
function working(snapshot: Snapshot): Snapshot {
  return { ...snapshot, workFinished: false, operationId, operationStatus: "working", activeOperationId: operationId,
    activeOperationStatus: "working", questions: [], outcome: undefined,
    output: { text: "正在读取文档…\n这是本地示例输出，没有运行任何命令。", truncated: false, revision: 1 } };
}
function completed(snapshot: Snapshot, text = "PREVIEW_OK\n这是本地演示结果，未调用模型、GitHub 或 MCP 服务。 "): Snapshot {
  return { ...snapshot, operationId, operationStatus: "completed", workFinished: true,
    activeOperationId: null, activeOperationStatus: undefined, questions: [], outcome: { finalResponse: text } };
}

/** Scripted UI fixtures, not a simulator of the Environment authority or runtime. */
export class PreviewSession {
  private scene: SceneId;
  private snapshot: Snapshot | undefined;
  private next: Snapshot | undefined;
  private now: number;

  constructor(scene: SceneId, executor: Executor, now = Date.now()) {
    this.scene = scene;
    this.now = now;
    let s = ready(executor, now);
    if (["working", "question", "unsupported-question", "historical"].includes(scene)) s = working(s);
    if (["completed", "long-result", "closed", "historical"].includes(scene)) {
      const text = scene === "long-result"
        ? markdownExample
        : undefined;
      const current = s;
      s = completed(s, text);
      if (scene === "historical") s = { ...s, historical: true,
        operationId: `task_${"a".repeat(32)}_${"c".repeat(32)}`,
        activeOperationId: current.activeOperationId, activeOperationStatus: "working" };
    }
    if (scene === "command-failed") s = { ...completed(s), outcome: { exitCode: 1, stdout: "Running checks…", stderr: "Example check failed.", truncated: false } };
    if (scene === "failed" || scene === "cancelled") s = { ...completed(s), operationStatus: scene, outcome: { message: "Example operation ended." } };
    if (scene === "question" || scene === "unsupported-question") s = { ...s, operationStatus: "input_required", activeOperationStatus: "input_required", questions: [{
      id: "color", operationId, message: "请选择一种颜色。", requestedSchema: { type: "object", properties: {
        color: scene === "question" ? { type: "string", title: "颜色", enum: ["amber", "blue", "green"] } : { type: "object" },
      }, required: ["color"] },
    }] };
    if (["opening", "closing", "closed", "unavailable"].includes(scene)) s = { ...s, environmentStatus: scene };
    if (scene === "unavailable") s.environmentReason = "runtime_disconnected";
    this.snapshot = scene === "empty" || scene === "capacity-global" ? undefined : s;
    if (scene === "opening") this.next = ready(executor, now);
    if (scene === "closing") this.next = { ...s, environmentStatus: "closed" };
    if (scene === "working") this.next = completed(s);
  }

  initial(): PreviewResult {
    if (this.scene === "capacity-owner") return { ...result({ outcome: "capacity_rejected", capacityKind: "owner", retryable: false,
      existingEnvironment: { environmentId, status: "ready" } }), isError: true };
    if (this.scene === "capacity-global") return { ...result({ outcome: "capacity_rejected", capacityKind: "global", retryable: true }), isError: true };
    if (this.scene === "empty" || this.scene === "list") return this.list();
    return result(this.snapshot!);
  }

  private list(): PreviewResult {
    const s = this.snapshot;
    return result({ environments: !s || s.environmentStatus === "closed" ? [] : [{
      environmentId: s.environmentId, executor: s.executor, status: s.environmentStatus,
      expiresAt: s.expiresAt, idleExpiresAt: s.idleExpiresAt,
    }] });
  }

  call(name: string, args: Record<string, unknown> = {}): PreviewResult {
    if (name === "list_environments") return this.list();
    if (name === "open_environment") {
      this.snapshot = { ...ready(args.executor === "grok" ? "grok" : "codex", this.now), environmentStatus: "opening" };
      this.next = { ...this.snapshot, environmentStatus: "ready" };
      return result(this.snapshot);
    }
    if (!this.snapshot) return rejected("ENVIRONMENT_NOT_FOUND");
    if (name === "inspect_environment") {
      if (this.next) { this.snapshot = this.next; this.next = undefined; }
      return result(this.snapshot);
    }
    if (name === "agent") {
      this.snapshot = working(this.snapshot);
      this.next = completed(this.snapshot);
    } else if (name === "close_environment") {
      this.snapshot = { ...this.snapshot, environmentStatus: "closing", questions: [] };
      this.next = { ...this.snapshot, environmentStatus: "closed", activeOperationId: null,
        activeOperationStatus: undefined, operationId: `${environmentId.replace("env_", "task_")}_close`,
        operationStatus: "completed", workFinished: true, outcome: undefined };
    } else if (name === "update_operation") {
      if (args.action === "cancel") {
        this.next = { ...completed(this.snapshot), operationStatus: "cancelled", outcome: undefined };
      } else if (args.action === "answer") {
        this.snapshot = { ...this.snapshot, questions: [], operationStatus: "working", activeOperationStatus: "working" };
        this.next = completed(this.snapshot, `PREVIEW_ANSWER\n${JSON.stringify(args.inputResponses, null, 2)}`);
      } else return rejected("INVALID_OPERATION_INPUT");
    } else return rejected("Unsupported preview tool");
    return result(this.snapshot);
  }
}
