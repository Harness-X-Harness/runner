import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "../apps/chatgpt-app/node_modules/esbuild/lib/main.js";
import { readView, selectedContext, refreshArguments, stateLabel, finalText, cancelArguments, replyMessage, questionFields, answerContent, reasonText, nextSentence, listStatus, commandText, commandTitle, operationStatusText, decidePromptSend, submissionDisposition, userFacingError } from "../apps/chatgpt-app/ui/view.ts";
import { environmentTools } from "../apps/chatgpt-app/src/environment-tools.ts";
import { readWorkbench, WORKBENCH_URI } from "../apps/chatgpt-app/src/workbench-resource.ts";

const environmentId = `env_${"a".repeat(32)}`;
const operationId = `task_${"a".repeat(32)}_${"b".repeat(32)}`;
const snapshot = { contract: "ordinary", environmentId, executor: "codex", environmentStatus: "ready",
  disposition: "accepted", workFinished: false, expiresAt: 12345, activeOperationId: operationId,
  activeOperationStatus: "working", operationId, operationStatus: "working" };

test("UI discovery uses the same seven tools and a credential-free standard resource", () => {
  const tools = environmentTools();
  for (const name of ["list_environments", "inspect_environment"]) {
    const tool = tools.find(tool => tool.name === name)!;
    assert.deepEqual(tool._meta?.ui, { resourceUri: WORKBENCH_URI, visibility: ["model", "app"] });
    assert.equal(tool.annotations?.readOnlyHint, true);
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
  assert.match(selectedContext(view).content[0]!.text, /snapshot, not live state/);
  assert.equal(view.receivedAt, 200);
  assert.throws(() => readView({ isError: true, content: [{ type: "text", text: "Read unavailable" }] }, 300), /Read unavailable/);
  assert.throws(() => readView({ structuredContent: { taskId: operationId, status: "working" } }, 300), /未返回工作区/);
});

test("display separates lifecycle, operation completion and semantic results", () => {
  const view = readView({ structuredContent: snapshot }, 1);
  assert.equal(view.kind, "environment");
  if (view.kind !== "environment") return;
  const s = view.snapshot;
  assert.equal(stateLabel(s), "进行中");
  assert.equal(finalText(s), undefined);
  assert.equal(stateLabel({ ...s, environmentStatus: "closing" }), "关闭中");
  assert.equal(stateLabel({ ...s, environmentStatus: "closed" }), "已关闭");
  assert.equal(stateLabel({ ...s, questions: [{ id: "q", operationId, message: "Choose" }] }), "等待输入");
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
  assert.match(replyMessage(s, "explain").content[0]!.text, new RegExp(s.operationId));
  assert.match(replyMessage(s, "continue").content[0]!.text, /当前工作区/);
  const answer = replyMessage({ ...s, questions: [{ id: "q", operationId, message: "Choose" }] }, "answer").content[0]!.text;
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
  assert.equal(stateLabel(ready), "就绪");
  assert.equal(stateLabel({ ...ready, outcome: { exitCode: 0, stdout: "", stderr: "", truncated: false } }), "就绪");
  assert.equal(stateLabel({ ...ready, outcome: { exitCode: 1, stdout: "", stderr: "failed", truncated: false } }), "失败");
  assert.equal(stateLabel({ ...snapshot, environmentStatus: "unavailable", environmentReason: "runtime_disconnected" }), "不可用");
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
  assert.match(selectedContext(capacity).content[0]!.text, /snapshot, not live state/);
});

test("a closed environment still shows the selected operation result", () => {
  const failed = { ...snapshot, environmentStatus: "closed", operationStatus: "failed", outcome: { message: "ended" } };
  assert.equal(stateLabel(failed), "已关闭 · 失败");
  assert.equal(nextSentence(failed), undefined);
  assert.equal(operationStatusText(failed), "失败");
  const cancelled = { ...snapshot, environmentStatus: "closed", activeOperationId: null, activeOperationStatus: undefined,
    operationStatus: "cancelled" };
  assert.equal(stateLabel(cancelled), "已关闭 · 已取消");
  assert.equal(nextSentence(cancelled), undefined);
  assert.equal(operationStatusText(cancelled), "已取消");
  const done = { ...snapshot, environmentStatus: "closed", activeOperationId: null, operationStatus: "completed",
    outcome: { finalResponse: "done" } };
  assert.equal(stateLabel(done), "已关闭");
  assert.equal(nextSentence(done), undefined);
  assert.equal(operationStatusText(done), "已完成");
});

test("timeout and signal failures use the native command failure rule", () => {
  const timeout = { ...snapshot, activeOperationId: null, activeOperationStatus: undefined, operationStatus: "completed",
    outcome: { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", truncated: false, stopReason: "timeout" } };
  const command = commandText(timeout);
  assert.ok(command);
  assert.equal(commandTitle(command!), "超时");
  assert.equal(stateLabel(timeout), "失败");
  assert.equal(nextSentence(timeout), undefined);
  assert.match(finalText(timeout)!, /timeout/);
  assert.match(finalText(timeout)!, /SIGTERM/);
  assert.doesNotMatch(finalText(timeout)!, /Exit code: none/);
  const signal = { ...timeout, outcome: { exitCode: null, signal: "SIGKILL", stdout: "partial", stderr: "", truncated: false } };
  assert.equal(commandTitle(commandText(signal)!), "信号 SIGKILL");
  assert.equal(stateLabel(signal), "失败");
  const success = { ...timeout, outcome: { exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false } };
  assert.equal(commandTitle(commandText(success)!), "结果");
  assert.equal(stateLabel(success), "就绪");
  assert.equal(nextSentence(success), undefined);
  const nullExit = { ...timeout, outcome: { exitCode: null, signal: null, stdout: "", stderr: "", truncated: false } };
  assert.equal(stateLabel(nullExit), "失败");
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

test("the rendered workbench exposes its only lifecycle label as a live status", async () => {
  const appRoot = new URL("../apps/chatgpt-app/", import.meta.url);
  const built = await build({
    stdin: { contents: `import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { Screen } from "./ui/screen.tsx";
      export function render(environmentStatus) {
        return renderToStaticMarkup(createElement(Screen, {
          view: { kind: "environment", receivedAt: 1, snapshot: {
            contract: "ordinary", environmentId: "env_fixture", executor: "codex", environmentStatus,
            disposition: "accepted", workFinished: false, expiresAt: null, activeOperationId: null,
          } }, now: 1, error: "", busy: false, connected: true, canCall: true, canMessage: true,
          creationKey: "fixture", onCall() {}, onSend: async () => "sent", onMessage() {},
        }));
      }`, resolveDir: fileURLToPath(appRoot), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom"],
  });
  const module = { exports: {} as { render(status: string): string } };
  new Function("require", "module", "exports", built.outputFiles[0]!.text)(createRequire(appRoot), module, module.exports);
  for (const [status, label] of [["opening", "启动中"], ["ready", "就绪"], ["closing", "关闭中"], ["closed", "已关闭"]]) {
    const rendered = module.exports.render(status!);
    assert.match(rendered, new RegExp(`<span class="status [^"]+" role="status">${label}</span>`));
    assert.doesNotMatch(rendered, /<span[^>]*class="status[^>]*aria-hidden/);
  }
});
