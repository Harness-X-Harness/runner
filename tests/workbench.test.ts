import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { readView, selectedContext, refreshArguments, lifecycleLabel, finalText, cancelArguments, replyMessage, questionFields, answerContent, reasonText, nextSentence, listStatus, commandText, commandTitle, operationStatusText, decidePromptSend, submissionDisposition, userFacingError } from "../apps/chatgpt-app/ui/view.ts";
import { environmentTools } from "../apps/chatgpt-app/src/environment-tools.ts";
import { readWorkbench, WORKBENCH_URI } from "../apps/chatgpt-app/src/workbench-resource.ts";

const environmentId = `env_${"a".repeat(32)}`;
const operationId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
const snapshot = { contract: "ordinary", environmentId, executor: "codex", environmentStatus: "ready",
  disposition: "accepted", workFinished: false, expiresAt: 12345, activeOperationId: operationId,
  activeOperationStatus: "working", operationId, operationStatus: "working" };

test("UI discovery uses the same seven tools and a credential-free standard resource", () => {
  const tools = environmentTools();
  assert.equal(tools.length, 7);
  for (const name of tools.map(tool => tool.name)) {
    const tool = tools.find(tool => tool.name === name)!;
    assert.deepEqual(tool._meta?.ui, { visibility: ["model", "app"],
      ...(["list_environments", "open_environment"].includes(name) ? { resourceUri: WORKBENCH_URI } : {}) });
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["environments:use"] }]);
    assert.equal(tool.annotations?.readOnlyHint, ["list_environments", "inspect_environment"].includes(name));
  }
  const resource = readWorkbench().contents[0]!;
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(resource.text, /<title>AgentEnv<\/title>/);
  assert.match(resource.text, /px-btn/);
  assert.match(resource.text, /--paper/);
  assert.match(resource.text, /--color-background-primary/);
  assert.match(resource.text, /--font-mono/);
  assert.match(resource.text, /--font-sans/);
  assert.doesNotMatch(resource.text, /min-height:\s*100vh/);
  assert.match(resource.text, /选择助手/);
  assert.match(resource.text, /输入指令/);
  assert.match(resource.text, /未收到响应。请先重试原指令。/);
  assert.match(resource.text, /刷新不会延长使用时间。/);
  assert.match(resource.text, /工作区内的所有文件将丢失，包括已保存和仅在本地提交的文件。请先推送或另存到外部。/);
  assert.doesNotMatch(resource.text, /未保存的文件将丢失/);
  assert.doesNotMatch(resource.text, />一个工作区</);
});

test("read-only entry and explicit refresh retain exact selection without creating work", () => {
  const list = readView({ structuredContent: { environments: [] } }, 100);
  assert.deepEqual(refreshArguments(list), { name: "list_environments", arguments: {} });
  const view = readView({ structuredContent: snapshot }, 200);
  assert.deepEqual(refreshArguments(view), { name: "inspect_environment", arguments: { environmentId, operationId } });
  assert.match(selectedContext(view).content[0]!.text, new RegExp(environmentId));
  assert.deepEqual(selectedContext(view), { content: [{ type: "text", text: `AgentEnv selection: environmentId=${environmentId}` }] });
  assert.equal(view.receivedAt, 200);
  assert.throws(() => readView({ isError: true, content: [{ type: "text", text: "Read unavailable" }] }, 300), /Read unavailable/);
  assert.throws(() => readView({ structuredContent: { taskId: operationId, status: "working" } }, 300), /未返回工作区/);
});

test("display separates lifecycle, operation completion and semantic results", () => {
  const view = readView({ structuredContent: snapshot }, 1);
  assert.equal(view.kind, "environment");
  if (view.kind !== "environment") return;
  const s = view.snapshot;
  assert.equal(lifecycleLabel(s.environmentStatus), "就绪");
  assert.equal(operationStatusText(s), "进行中");
  assert.equal(finalText(s), undefined);
  assert.equal(lifecycleLabel("closing"), "关闭中");
  assert.equal(lifecycleLabel("closed"), "已关闭");
  assert.equal(operationStatusText({ ...s, operationStatus: "input_required" }), "等待输入");
  assert.equal(finalText({ ...s, operationStatus: "completed", outcome: { finalResponse: "<script>untrusted</script>" } }), "<script>untrusted</script>");
  assert.equal(finalText({ ...s, operationStatus: "working", outcome: { finalResponse: "not final" } }), undefined);
  assert.match(finalText({ ...s, operationStatus: "completed", outcome: { exitCode: 1, stdout: "", stderr: "failed", truncated: true } })!, /Exit code: 1.*failed.*truncated/s);
});

test("cancel and conversational actions preserve exact selection and active operation identity", () => {
  const view = readView({ structuredContent: snapshot }, 1);
  if (view.kind !== "environment") throw new Error("fixture");
  const s = { ...view.snapshot, operationId: `task_${"a".repeat(32)}_${"c".repeat(32)}`, historical: true };
  assert.deepEqual(cancelArguments(s), { operationId, action: "cancel" });
  assert.equal(cancelArguments({ ...s, activeOperationStatus: "completed" }), undefined);
  assert.equal(cancelArguments({ ...s, environmentStatus: "closed" }), undefined);
  const answer = replyMessage({ ...s, questions: [{ id: "q", operationId, message: "Choose" }] }).content[0]!.text;
  assert.match(answer, /不要开始新的回合/);
  assert.match(answer, new RegExp(`operationId=${operationId}`));
  assert.doesNotMatch(answer, new RegExp(s.operationId));
});

test("question fields preserve types, validate schema, and allow standard decline outside forms", () => {
  const question = { id: "q", operationId, message: "Choose settings", requestedSchema: { type: "object", properties: {
    name: { type: "string", minLength: 2 }, count: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" }, target: { type: "string", enum: ["fast", "safe"] },
    features: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1 },
  }, required: ["name", "count", "enabled", "features"] } };
  assert.equal(questionFields(question)?.find(field => field.name === "count")?.required, true);
  const form = new FormData();
  form.set("name", "Build"); form.set("count", "2"); form.set("target", "1"); form.append("features", "a");
  assert.deepEqual(answerContent(question, form), { name: "Build", count: 2, enabled: false, target: "safe", features: ["a"] });
  form.set("count", "0"); assert.throws(() => answerContent(question, form));
  assert.equal(questionFields({ ...question, requestedSchema: { type: "object", properties: { obj: { type: "object" } } } }), undefined);
});

test("the workbench tells a person the next fact and keeps a rejected open actionable", () => {
  const ready = { ...snapshot, activeOperationId: null, activeOperationStatus: undefined, operationStatus: "completed",
    outcome: { finalResponse: "done" } };
  assert.equal(lifecycleLabel(ready.environmentStatus), "就绪");
  assert.equal(operationStatusText({ ...ready, outcome: { exitCode: 0, stdout: "", stderr: "", truncated: false } }), "已完成");
  assert.equal(operationStatusText({ ...ready, outcome: { exitCode: 1, stdout: "", stderr: "failed", truncated: false } }), "失败");
  assert.equal(lifecycleLabel("unavailable"), "不可用");
  assert.equal(reasonText("idle_expired"), "闲置时间已到。");
  const idle = { ...ready, environmentStatus: "unavailable", environmentReason: "idle_expired" };
  assert.equal(nextSentence(idle), "闲置时间已到。");
  assert.equal(nextSentence({ ...idle, environmentStatus: "closed" }), undefined);
  assert.equal(listStatus({ environmentId, executor: "codex", status: "unavailable", expiresAt: null, reason: "idle_expired" }, 0), "闲置时间已到");
  assert.equal(userFacingError("INVALID_OPERATION_INPUT"), "输入无效。请修改后再发送。");
  assert.equal(submissionDisposition("INVALID_OPERATION_INPUT"), "rejected");
  assert.equal(submissionDisposition(""), "unknown");
  assert.equal(submissionDisposition("Task request failed"), "unknown");
  assert.equal(submissionDisposition("Read failed after ENVIRONMENT_NOT_READY"), "unknown");
  const capacity = readView({ isError: true, structuredContent: {
    outcome: "capacity_rejected", capacityKind: "owner", retryable: false,
    existingEnvironment: { environmentId, status: "ready" },
  }, content: [{ type: "text", text: "You already have a workspace." }] }, 5);
  assert.equal(capacity.kind, "capacity");
  if (capacity.kind !== "capacity") return;
  assert.equal(capacity.existing?.environmentId, environmentId);
  assert.deepEqual(refreshArguments(capacity), { name: "inspect_environment", arguments: { environmentId } });
  assert.equal(selectedContext(capacity), undefined);
});

test("a closed environment still shows the selected operation result", () => {
  const failed = { ...snapshot, environmentStatus: "closed", operationStatus: "failed", outcome: { message: "ended" } };
  assert.equal(lifecycleLabel(failed.environmentStatus), "已关闭");
  assert.equal(nextSentence(failed), undefined);
  assert.equal(operationStatusText(failed), "失败");
  const cancelled = { ...snapshot, environmentStatus: "closed", activeOperationId: null, activeOperationStatus: undefined,
    operationStatus: "cancelled" };
  assert.equal(lifecycleLabel(cancelled.environmentStatus), "已关闭");
  assert.equal(nextSentence(cancelled), undefined);
  assert.equal(operationStatusText(cancelled), "已取消");
  const done = { ...snapshot, environmentStatus: "closed", activeOperationId: null, operationStatus: "completed",
    outcome: { finalResponse: "done" } };
  assert.equal(lifecycleLabel(done.environmentStatus), "已关闭");
  assert.equal(nextSentence(done), undefined);
  assert.equal(operationStatusText(done), "已完成");
});

test("timeout and signal failures use the native command failure rule", () => {
  const timeout = { ...snapshot, activeOperationId: null, activeOperationStatus: undefined, operationStatus: "completed",
    outcome: { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", truncated: false, stopReason: "timeout" } };
  const command = commandText(timeout);
  assert.ok(command);
  assert.equal(commandTitle(command!), "超时");
  assert.equal(operationStatusText(timeout), "失败");
  assert.equal(nextSentence(timeout), undefined);
  assert.match(finalText(timeout)!, /timeout/);
  assert.match(finalText(timeout)!, /SIGTERM/);
  assert.doesNotMatch(finalText(timeout)!, /Exit code: none/);
  const signal = { ...timeout, outcome: { exitCode: null, signal: "SIGKILL", stdout: "partial", stderr: "", truncated: false } };
  assert.equal(commandTitle(commandText(signal)!), "信号 SIGKILL");
  assert.equal(operationStatusText(signal), "失败");
  const success = { ...timeout, outcome: { exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false } };
  assert.equal(commandTitle(commandText(success)!), "结果");
  assert.equal(operationStatusText(success), "已完成");
  assert.equal(nextSentence(success), undefined);
  const nullExit = { ...timeout, outcome: { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false } };
  assert.equal(operationStatusText(nullExit), "失败");
  assert.equal(commandTitle(commandText(nullExit)!), "失败");
});

test("an unconfirmed prompt keeps its key until its own response arrives", () => {
  const first = decidePromptSend(undefined, environmentId, "  构建  ", "key-1");
  assert.equal(first.action, "send");
  if (first.action !== "send") return;
  assert.equal(first.key, "key-1");
  assert.equal(first.lease.text, "构建");
  const retry = decidePromptSend(first.lease, environmentId, "构建", "key-2");
  assert.equal(retry.action, "send");
  if (retry.action !== "send") return;
  assert.equal(retry.key, "key-1");
  assert.equal(decidePromptSend(first.lease, environmentId, "换一句", "key-3").action, "blocked");
  const fresh = decidePromptSend(undefined, environmentId, "换一句", "key-6");
  assert.equal(fresh.action, "send");
  if (fresh.action !== "send") return;
  assert.equal(fresh.key, "key-6");
});

async function screenRenderer() {
  const appRoot = new URL("../apps/chatgpt-app/", import.meta.url);
  const built = await build({
    stdin: { contents: `import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { Screen } from "./ui/screen.tsx";
      export function render(environmentStatus, overrides = {}) {
        return renderToStaticMarkup(createElement(Screen, {
          view: { kind: "environment", receivedAt: 1, snapshot: {
            contract: "ordinary", environmentId: "env_fixture", executor: "codex", environmentStatus,
            disposition: "accepted", workFinished: true, expiresAt: 21600001, idleExpiresAt: 900001,
            activeOperationId: null, operationStatus: "completed", outcome: { finalResponse: "RETAINED_RESULT" }, ...overrides,
          } }, now: 1, error: "", busy: false, connected: true, canCall: true, canMessage: true,
          creationKey: "fixture", onCall() {}, onSend: async () => "sent", onMessage() {}, onOpenLink() {},
        }));
      }`, resolveDir: fileURLToPath(appRoot), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom"],
  });
  const module = { exports: {} as { render(status: string, overrides?: Record<string, unknown>): string } };
  new Function("require", "module", "exports", built.outputFiles[0]!.text)(createRequire(appRoot), module, module.exports);
  return module.exports.render;
}

test("the compact pixel workbench keeps lifecycle, outcome and closed usage distinct", async () => {
  const render = await screenRenderer();
  for (const [status, label] of [["opening", "启动中"], ["ready", "就绪"], ["closing", "关闭中"], ["closed", "已关闭"]]) {
    const rendered = render(status!);
    assert.match(rendered, new RegExp(`<span class="status [^"]+" role="status"[^>]+data-hint="工作区：${label}"`));
    assert.doesNotMatch(rendered, /<span[^>]*class="status [^"]*"[^>]*aria-hidden/);
    assert.match(rendered, /RETAINED_RESULT/);
    assert.match(rendered, /<nav aria-label="工作区操作">/);
    assert.match(rendered, /role="region" aria-label="助手回复"/);
    assert.doesNotMatch(rendered, /<details|解释结果|<h2[^>]*>结果/);
    assert.doesNotMatch(rendered, /<footer[^>]*>.*<button/);
    if (status === "closed") {
      assert.doesNotMatch(rendered, /关闭时间|闲置时间|刷新不会延长使用时间/);
      assert.doesNotMatch(rendered, /aria-label="关闭工作区"|class="prompt"/);
    } else {
      assert.match(rendered, /关闭时间/);
      assert.match(rendered, /闲置时间/);
    }
  }
  const failed = render("ready", { operationStatus: "failed", outcome: undefined });
  assert.match(failed, /data-hint="工作区：就绪"/);
  assert.match(failed, /class="operation-state bad" role="status">失败/);
  const oldFailure = render("ready", { operationId: "old", operationStatus: "failed", outcome: undefined,
    activeOperationId: "current", activeOperationStatus: "working", historical: true });
  assert.match(oldFailure, /失败/);
  assert.match(oldFailure, /当前操作 · .*进行中/);
});

test("final replies render Markdown safely while command output and progress remain literal", async () => {
  const render = await screenRenderer();
  const markdown = [
    "# Summary", "", "A **clear** reply with `code`.", "",
    "- one", "- two", "", "> quoted", "",
    "```ts", '<script>alert("literal code")</script>', "```", "",
    "| Item | State |", "| --- | --- |", "| check | done |", "",
    "- [x] read only", "",
    "[docs](https://example.com/docs)", "",
    "[bad](javascript:alert%281%29) [file](file:///tmp/private) [relative](/authorize)", "",
    "![image description](https://example.com/image.png)", "",
    '<script>alert("raw HTML")</script><iframe src="https://example.com"></iframe>',
  ].join("\n");
  const rendered = render("ready", { outcome: { finalResponse: markdown } });
  assert.match(rendered, /<h1>Summary<\/h1>/);
  assert.match(rendered, /<strong>clear<\/strong>/);
  assert.match(rendered, /<ul>.*<li>one<\/li>.*<li>two<\/li>/s);
  assert.match(rendered, /<blockquote>/);
  assert.match(rendered, /<pre[^>]*><code class="language-ts">&lt;script&gt;/);
  assert.match(rendered, /<table>.*<th>Item<\/th>.*<td>done<\/td>/s);
  assert.match(rendered, /role="img" aria-label="已完成"/);
  assert.doesNotMatch(rendered, /type="checkbox"/);
  assert.match(rendered, /<a href="https:\/\/example.com\/docs">docs<\/a>/);
  assert.match(rendered, /image description/);
  assert.doesNotMatch(rendered, /<script|<iframe|<img|javascript:|file:\/\/|href="\/authorize"/);
  const literal = "# not a heading\n<script>literal output</script>";
  const command = render("ready", { outcome: { exitCode: 0, stdout: literal, stderr: "", truncated: false } });
  const progress = render("ready", { operationStatus: "working", outcome: undefined,
    output: { text: literal, truncated: false, revision: 1 } });
  for (const output of [command, progress]) {
    assert.match(output, /<pre[^>]*># not a heading\n&lt;script&gt;literal output&lt;\/script&gt;<\/pre>/);
    assert.doesNotMatch(output, /<h1>not a heading/);
  }
});

test("semantic command panel keeps evidence separate from literal logs and active work", async () => {
  const render = await screenRenderer();
  const environmentId = `env_${"a".repeat(32)}`;
  const operationId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
  const base = { environmentId, operationId, disposition: "result", outcome: {
    exitCode: 1, signal: null, stdout: '{"status":"passed"} <script>literal</script>',
    stderr: "ORIGINAL_ERROR", truncated: true,
  } };
  const html = render("ready", base);
  assert.match(html, /aria-label="命令结果"/);
  assert.match(html, /命令失败/);
  assert.match(html, /退出码 1/);
  assert.match(html, /来源：Runner 命令/);
  assert.match(html, /输出已截断/);
  assert.match(html, /ORIGINAL_ERROR/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<a |命令成功/);
  assert.match(html, /aria-label="原始命令日志" tabIndex="0"|tabindex="0" aria-label="原始命令日志"/i);
  const cancelled = render("ready", { ...base, operationStatus: "cancelled", disposition: "cancelled",
    outcome: { ...base.outcome, stopReason: "cancelled", exitCode: 0, signal: "SIGKILL" } });
  assert.match(cancelled, /命令已取消/);
  assert.match(cancelled, /ORIGINAL_ERROR/);
  assert.doesNotMatch(cancelled, /命令成功/);
  const historical = render("ready", { ...base, historical: true, workFinished: false,
    activeOperationId: `task_${"a".repeat(32)}_${"c".repeat(32)}`, activeOperationStatus: "working" });
  assert.match(historical, /较早的结果/);
  assert.match(historical, /当前操作 · .*进行中/);
  const fallback = render("ready", { ...base, outcome: { finalResponse: JSON.stringify(base.outcome) } });
  assert.match(fallback, /aria-label="助手回复"/);
  assert.doesNotMatch(fallback, /aria-label="命令结果"/);
});


test("context contains only an explicitly selected Environment, never list/capacity or snapshot churn", () => {
  assert.equal(selectedContext(readView({ structuredContent: { environments: [] } }, 100)), undefined);
  const old = readView({ structuredContent: { ...snapshot, historical: true, outcome: { finalResponse: "PRIVATE_PROMPT" }, output: { text: "PRIVATE_LOG", revision: 1, truncated: false } } }, 100);
  const refreshed = readView({ structuredContent: { ...snapshot, operationId: "old", environmentStatus: "opening" } }, 99999);
  assert.deepEqual(selectedContext(old), selectedContext(refreshed));
  assert.doesNotMatch(JSON.stringify(selectedContext(old)), /operationId|PRIVATE|working|ready|1970|no environment selected/);
});
