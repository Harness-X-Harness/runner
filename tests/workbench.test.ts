import assert from "node:assert/strict";
import test from "node:test";
import { readView, selectedContext, refreshArguments, stateLabel, finalText, cancelArguments, replyMessage, questionFields, answerContent } from "../apps/chatgpt-app/ui/view.ts";
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
  assert.throws(() => readView({ structuredContent: { taskId: operationId, status: "working" } }, 300), /No environment snapshot/);
});

test("display separates lifecycle, operation completion and semantic results", () => {
  const view = readView({ structuredContent: snapshot }, 1);
  assert.equal(view.kind, "environment");
  if (view.kind !== "environment") return;
  const s = view.snapshot;
  assert.equal(stateLabel(s), "Working");
  assert.equal(finalText(s), undefined);
  assert.equal(stateLabel({ ...s, environmentStatus: "closing" }), "Closing");
  assert.equal(stateLabel({ ...s, environmentStatus: "closed" }), "Closed");
  assert.equal(stateLabel({ ...s, questions: [{ id: "q", operationId, message: "Choose" }] }), "Needs your answer");
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
  assert.match(replyMessage(s, "continue").content[0]!.text, /existing environment/);
  const answer = replyMessage({ ...s, questions: [{ id: "q", operationId, message: "Choose" }] }, "answer").content[0]!.text;
  assert.match(answer, /Do not create a new agent turn/);
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
