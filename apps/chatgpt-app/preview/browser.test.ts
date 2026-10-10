import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startPreview } from "./server.ts";
import { scenes } from "./scenarios.ts";

const exec = promisify(execFile);

test("production card interactions in a local MCP Apps host", { timeout: 360_000 }, async t => {
  const { server, url } = await startPreview(0);
  const session = `agentenv-ui-test-${process.pid}`;
  const browser = async (...args: string[]) => {
    const { stdout } = await exec("agent-browser", ["--session", session, "--headed", "false", "--restore-save", "never", ...args],
      { timeout: 35_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  };
  const evaluate = async (source: string) => JSON.parse(await browser("eval", "-b", Buffer.from(source).toString("base64")));
  const doc = 'document.querySelector("iframe").contentDocument';
  const waitFor = (condition: string) => browser("wait", "--fn", `(() => { const d = ${doc}; return Boolean(${condition}); })()`);
  const text = () => evaluate(`Array.from(${doc}.querySelectorAll('main,[role="alertdialog"]')).map(el => el.textContent).join("\\n")`);
  const act = async (role: string, name: string, action: string, ...args: string[]) => {
    // The CLI scrolls inside an iframe, but does not reveal it in the parent page.
    if (!["场景", "助手", "主题", "宽度", "回复延迟", "下一次工具调用", "重置场景"].includes(name)) {
      await browser("scrollintoview", "iframe");
    }
    const snapshot = JSON.parse(await browser("snapshot", "-i", "--json"));
    const refs = Object.entries(snapshot.data.refs as Record<string, { role: string; name: string }>);
    const matches = refs.filter(([, item]) => item.role === role && item.name === name);
    assert.equal(matches.length, 1, `Expected one ${role} '${name}': ${snapshot.data.snapshot}`);
    return browser(action, `@${matches[0]![0]}`, ...args);
  };
  const click = (name: string) => act("button", name, "click");
  const toolCalls = () => evaluate('Array.from(document.querySelectorAll("#log li")).filter(el => el.querySelector("strong").textContent.startsWith("工具 →")).map(el => ({name:el.querySelector("strong").textContent, args:JSON.parse(el.querySelector("pre").textContent)}))');
  const open = async (scene: string, options = "") => {
    await browser("open", `${url}/?scene=${scene}${options}`);
    await browser("wait", "--fn", 'document.querySelector("#bridge-status")?.textContent.startsWith("本地宿主已连接")');
    await waitFor('d?.querySelector("header button:not(:disabled)")');
    await act("combobox", "回复延迟", "select", "0");
  };
  const idle = () => waitFor('d.querySelector("main")?.getAttribute("aria-busy") === "false"');

  try {
    await t.test("open, send, inspect and close through the real bridge", async () => {
      await open("empty");
      await click("Codex 打开 Codex");
      await waitFor('d.querySelector(".status")?.textContent === "启动中"');
      await click("刷新");
      await waitFor('d.querySelector(".status")?.textContent === "就绪"');
      await act("combobox", "回复延迟", "select", "1500");
      await act("textbox", "指令", "fill", "UI_LOCAL_SEND");
      await click("发送");
      await waitFor('d.querySelector("main")?.getAttribute("aria-busy") === "true"');
      assert.equal(await evaluate(`${doc}.querySelectorAll("button:not(:disabled)").length`), 0);
      await waitFor('d.querySelector(".operation-state")?.textContent === "进行中"');
      await idle();
      await act("combobox", "回复延迟", "select", "0");
      await click("刷新");
      await waitFor('d.querySelector(".result")?.textContent.includes("PREVIEW_OK")');
      await idle();
      assert.doesNotMatch(await text(), /解释结果/);
      await click("关闭工作区");
      await waitFor('d.querySelector("[role=alertdialog]")');
      assert.match(await text(), /所有文件将丢失/);
      await click("取消");
      await waitFor('!d.querySelector("[role=alertdialog]")');
      assert.equal((await toolCalls()).filter((call: {name: string}) => call.name === "工具 → close_environment").length, 0);
      await click("关闭工作区");
      await waitFor('d.querySelector("[role=alertdialog]")');
      await click("关闭");
      await waitFor('d.querySelector(".status")?.textContent === "关闭中"');
      await idle();
      await click("刷新");
      await waitFor('d.querySelector(".status")?.textContent === "已关闭"');
      assert.doesNotMatch(await text(), /关闭时间|闲置时间|刷新不会延长使用时间/);
      assert.equal((await toolCalls()).filter((call: {name: string}) => call.name === "工具 → agent").length, 1);
      await click("列表");
      await waitFor('d.querySelector("h1")?.textContent === "选择助手"');
    });

    await t.test("passive bridge results and refresh never publish context", async () => {
      await open("empty");
      const contexts = () => evaluate('Array.from(document.querySelectorAll("#log li")).filter(el => el.querySelector("strong").textContent.startsWith("Model Context")).length');
      assert.equal(await contexts(), 0);
      await click("Codex 打开 Codex");
      await idle();
      await click("刷新");
      await idle();
      assert.equal(await contexts(), 0);
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 1);
    });

    await t.test("launcher metadata controls simulated chat views; refresh retains one iframe", async () => {
      await open("opening");
      await evaluate('window.originalFrame = document.querySelector("iframe"); true');
      await click("刷新");
      await waitFor('d.querySelector(".status")?.textContent === "就绪"');
      for (const name of ["command", "agent", "inspect_environment"]) {
        await evaluate(`window.previewHost.chatTool("${name}").then(() => true)`);
        assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 1);
      }
      assert.equal(await evaluate('document.querySelector("iframe") === window.originalFrame'), true);
      await evaluate('window.previewHost.chatTool("list_environments").then(() => true)');
      await browser("wait", "--fn", 'Boolean(document.querySelectorAll("iframe").length === 2 && document.querySelectorAll("iframe")[1].contentDocument?.querySelector("main"))');
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2);
      await evaluate('window.previewHost.chatTool("open_environment").then(() => true)');
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 3);
    });

    await t.test("on-demand show_workbench appends a current card; refresh stays there without context churn", async () => {
      await open("command-historical", "&width=375&theme=dark");
      await evaluate('window.originalFrame = document.querySelector("iframe"); true');
      for (const name of ["inspect_environment", "command", "agent"]) {
        await evaluate(`window.previewHost.chatTool("${name}").then(() => true)`);
      }
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 1);
      await evaluate('window.previewHost.chatTool("show_workbench").then(() => true)');
      await browser("wait", "--fn", 'Boolean(document.querySelectorAll("iframe")[1]?.contentDocument?.querySelector(".command-panel"))');
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2);
      assert.equal(await evaluate('document.querySelector("iframe") === window.originalFrame'), true);
      assert.equal(await evaluate('document.querySelectorAll("iframe")[1].contentDocument.querySelector(".command-status").textContent'), "命令成功");
      assert.equal(await evaluate('document.querySelectorAll("iframe")[1].contentDocument.querySelector(".command-evidence").textContent.includes("较早的结果")'), true);
      await evaluate(`window.currentFrame = document.querySelectorAll("iframe")[1]; window.currentFrame.contentDocument.querySelector('[aria-label="刷新"]').click(); true`);
      await browser("wait", "--fn", 'Boolean(window.currentFrame.contentDocument.querySelector("main")?.getAttribute("aria-busy") === "false")');
      assert.equal(await evaluate('document.querySelectorAll("iframe")[1] === window.currentFrame'), true);
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2);
      assert.deepEqual((await toolCalls()).map((call: {name: string}) => call.name), ["工具 → inspect_environment"]);
      await evaluate('window.previewHost.chatTool("show_workbench").then(() => true)');
      await browser("wait", "--fn", 'Boolean(document.querySelectorAll("iframe")[2]?.contentDocument?.querySelector(".command-panel"))');
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 3);
      assert.equal(await evaluate('Array.from(document.querySelectorAll("#log li")).filter(el => el.querySelector("strong").textContent.startsWith("Model Context")).length'), 0);
      await open("opening");
      await click("刷新");
      await waitFor('d.querySelector(".status")?.textContent === "就绪"');
      await evaluate('window.previewHost.chatTool("show_workbench").then(() => true)');
      await browser("wait", "--fn", 'Boolean(document.querySelectorAll("iframe")[1]?.contentDocument?.querySelector(".status")?.textContent === "就绪")');
      assert.deepEqual((await toolCalls()).map((call: {name: string}) => call.name), ["工具 → inspect_environment"]);
      await open("empty");
      await evaluate('window.previewHost.chatTool("show_workbench").then(() => true)');
      await browser("wait", "--fn", 'Boolean(document.querySelectorAll("iframe")[1]?.contentDocument?.querySelector("h1")?.textContent === "选择助手")');
      assert.equal((await toolCalls()).length, 0);
      assert.equal(await evaluate('document.querySelectorAll("#log li").length'), 0);
    });

    await t.test("context is explicit, minimal and reassertable; late views stay silent", async () => {
      await open("command-historical");
      const contexts = () => evaluate('Array.from(document.querySelectorAll("#log li")).filter(el => el.querySelector("strong").textContent.startsWith("Model Context")).map(el => JSON.parse(el.querySelector("pre").textContent))');
      assert.deepEqual(await contexts(), []);
      await click("在对话中使用此工作区");
      await idle();
      assert.match(await text(), /宿主已确认/);
      assert.deepEqual(await contexts(), [{ content: [{ type: "text", text: `AgentEnv selection: environmentId=env_${"a".repeat(32)}` }] }]);
      await click("在对话中使用此工作区");
      await idle();
      assert.equal((await contexts()).length, 2);
      assert.match(await text(), /宿主已确认/);
      await click("刷新");
      await idle();
      assert.equal((await contexts()).length, 2);
      await open("ready", "&context=unsupported");
      await click("在对话中使用此工作区");
      await idle();
      assert.match(await text(), /不支持共享选择/);
      assert.deepEqual(await contexts(), []);
      await open("ready", "&context=fail-once");
      await click("在对话中使用此工作区");
      await idle();
      assert.match(await text(), /未确认选择/);
      await click("在对话中使用此工作区");
      await idle();
      assert.match(await text(), /宿主已确认/);
      assert.equal((await contexts()).length, 2);
      await open("ready", "&multiple=1");
      await evaluate(`Array.from(${doc}.querySelectorAll("button")).find(button => button.textContent === "在对话中使用此工作区").click(); true`);
      await idle();
      assert.equal((await contexts()).length, 1);
      await evaluate('window.previewHost.lateResults().then(() => true)');
      await idle();
      assert.equal((await contexts()).length, 1);
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 2);
    });

    await t.test("independent AppBridge cards allow explicit A to B to A re-selection", async () => {
      await open("ready", "&multiple=1");
      await browser("wait", "--fn", 'Boolean(document.querySelectorAll("iframe")[1]?.contentDocument?.querySelector("#workbench-mode"))');
      const environmentA = `env_${"a".repeat(32)}`;
      const environmentB = `env_${"b".repeat(32)}`;
      await evaluate(`window.previewHost.selectEnvironment(1, "${environmentB}", "grok").then(() => true)`);
      await browser("wait", "--fn", 'document.querySelectorAll("iframe")[1].contentDocument.querySelector("h1")?.textContent === "Grok"');
      const share = async (card: number) => {
        await evaluate(`Array.from(document.querySelectorAll("iframe")[${card}].contentDocument.querySelectorAll("button")).find(button => button.textContent === "在对话中使用此工作区").click(); true`);
        await browser("wait", "--fn", `Boolean(document.querySelectorAll("iframe")[${card}].contentDocument.querySelector("main")?.getAttribute("aria-busy") === "false")`);
      };
      await share(0);
      await share(1);
      await share(0);
      const contexts = () => evaluate('Array.from(document.querySelectorAll("#log li")).filter(el => el.querySelector("strong").textContent.startsWith("Model Context")).map(el => JSON.parse(el.querySelector("pre").textContent))');
      assert.deepEqual(await contexts(), [environmentA, environmentB, environmentA].map(environmentId => ({
        content: [{ type: "text", text: `AgentEnv selection: environmentId=${environmentId}` }],
      })));
      await evaluate('window.previewHost.lateResults().then(() => true)');
      await idle();
      assert.equal((await contexts()).length, 3);
    });

    await t.test("a different Environment resets input mode and drafts in the same iframe", async () => {
      await open("ready");
      await evaluate('window.selectionFrame = document.querySelector("iframe"); true');
      await act("combobox", "输入模式", "select", "result");
      await act("textbox", "操作 ID", "fill", `task_${"a".repeat(32)}_${"b".repeat(32)}`);
      await click("刷新");
      await idle();
      assert.equal(await evaluate(`${doc}.querySelector('#workbench-mode').value`), "result");
      assert.match(await evaluate(`${doc}.querySelector('#selected-operation').value`), /^task_/);
      await evaluate(`window.previewHost.selectEnvironment(0, "env_${"b".repeat(32)}", "grok").then(() => true)`);
      await waitFor('d.querySelector("h1")?.textContent === "Grok"');
      await idle();
      assert.equal(await evaluate(`${doc}.querySelector('#workbench-mode').value`), "agent");
      assert.equal(await evaluate(`${doc}.querySelector('#next-request').value`), "");
      assert.equal(await evaluate('document.querySelector("iframe") === window.selectionFrame'), true);
      await act("combobox", "输入模式", "select", "result");
      assert.equal(await evaluate(`${doc}.querySelector('#selected-operation').value`), "");
      await act("combobox", "输入模式", "select", "command");
      await act("textbox", "命令参数（JSON 数组）", "fill", '["pwd"]');
      await evaluate(`window.previewHost.selectEnvironment(0, "env_${"a".repeat(32)}", "codex").then(() => true)`);
      await waitFor('d.querySelector("h1")?.textContent === "Codex"');
      await idle();
      assert.equal(await evaluate(`${doc}.querySelector('#workbench-mode').value`), "agent");
      await act("combobox", "输入模式", "select", "command");
      assert.equal(await evaluate(`${doc}.querySelector('#command-argv').value`), "");
    });

    await t.test("in-card literal command and historical lookup keep trusted output reachable", async () => {
      await open("ready");
      await act("combobox", "输入模式", "select", "command");
      await act("textbox", "命令参数（JSON 数组）", "fill", '["printf", "$(literal)", "a b"]');
      await click("运行命令");
      await idle();
      const calls = await toolCalls();
      assert.equal(calls[0].name, "工具 → command");
      assert.deepEqual(calls[0].args.argv, ["printf", "$(literal)", "a b"]);
      assert.equal(calls[0].args.timeoutSeconds, 30);
      assert.equal(calls[0].args.cwd, ".");
      await click("刷新");
      await idle();
      assert.match(await text(), /命令成功.*LOCAL_COMMAND_OUTPUT/s);
      const resultId = await evaluate(`${doc}.querySelector('.command-panel').dataset.operationId`);
      await act("combobox", "输入模式", "select", "result");
      await act("textbox", "操作 ID", "fill", resultId);
      await click("查看结果");
      await idle();
      assert.equal(await evaluate(`${doc}.querySelector('.command-panel').dataset.operationId`), resultId);
      assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 1);
      await open("ready");
      await act("combobox", "输入模式", "select", "command");
      await act("combobox", "下一次工具调用", "select", "unknown");
      await act("textbox", "命令参数（JSON 数组）", "fill", '["pwd"]');
      await click("运行命令");
      await idle();
      await act("textbox", "命令参数（JSON 数组）", "fill", '["git", "status"]');
      await click("运行命令");
      await idle();
      assert.equal((await toolCalls()).length, 1);
      await act("textbox", "命令参数（JSON 数组）", "fill", '["pwd"]');
      await click("运行命令");
      await idle();
      const retried = await toolCalls();
      assert.equal(retried.length, 2);
      assert.equal(retried[0].args.idempotencyKey, retried[1].args.idempotencyKey);
      await open("command-historical");
      const historical = await evaluate(`${doc}.querySelector('.command-panel').dataset.operationId`);
      await click("停止");
      await waitFor('d.querySelector("[role=alertdialog]")');
      await click("停止");
      await idle();
      await click("刷新");
      await idle();
      assert.equal(await evaluate(`${doc}.querySelector('.command-panel').dataset.operationId`), historical);
      assert.match(await text(), /LOCAL_COMMAND_OUTPUT/);
      assert.equal(await evaluate(`${doc}.querySelectorAll('.operation-bar').length`), 0);
    });

    await t.test("stop targets the active operation, even when an older result is selected", async () => {
      await open("historical");
      await click("停止");
      await waitFor('d.querySelector("[role=alertdialog]")');
      await click("停止");
      await waitFor('!d.querySelector("[role=alertdialog]")');
      await idle();
      const calls = await toolCalls();
      assert.equal(calls[0].args.operationId, `task_${"a".repeat(32)}_${"b".repeat(32)}`);
      assert.equal(calls[0].args.action, "cancel");
      await click("刷新");
      await waitFor('d.querySelector(".operation-state")?.textContent === "已取消"');
      assert.equal(await evaluate(`${doc}.querySelector(".status").textContent`), "就绪");
    });

    await t.test("question form accepts a typed answer and supports decline", async () => {
      await open("question");
      await act("combobox", "颜色 *", "select", "0");
      await click("提交");
      await waitFor('!d.querySelector("fieldset")');
      await idle();
      await click("刷新");
      await waitFor('d.querySelector(".result")?.textContent.includes("amber")');
      await open("question");
      await click("拒绝");
      await waitFor('d.querySelector("[role=alertdialog]")');
      await click("拒绝");
      await waitFor('!d.querySelector("[role=alertdialog]")');
      await idle();
      assert.equal((await toolCalls())[0].args.inputResponses.color.action, "decline");
      await open("unsupported-question");
      await click("在对话中回答");
      await idle();
      await click("交互记录");
      assert.equal(await evaluate('document.querySelector("#toggle-log").getAttribute("aria-expanded")'), "true");
      assert.equal(await evaluate('document.querySelector("#log-count").textContent'), "1 条");
      assert.match(await browser("get", "text", "#log"), /对话消息 → 仅记录，未发送/);
      await click("交互记录");
      assert.equal(await evaluate('document.querySelector("#trace").hidden'), true);
    });

    await t.test("rejection permits editing; unconfirmed send preserves the original request key", async () => {
      await open("ready");
      await act("combobox", "下一次工具调用", "select", "rejected");
      await act("textbox", "指令", "fill", "first");
      await click("发送");
      await waitFor('d.querySelector("[role=alert]")?.textContent.includes("输入无效")');
      await idle();
      await act("textbox", "指令", "fill", "changed");
      await click("发送");
      await waitFor('d.querySelector(".operation-state")?.textContent === "进行中"');
      await open("ready");
      await act("combobox", "下一次工具调用", "select", "unknown");
      await act("textbox", "指令", "fill", "original");
      await click("发送");
      await waitFor('d.querySelector("[role=alert]")?.textContent.includes("未收到响应")');
      await idle();
      await act("textbox", "指令", "fill", "different");
      assert.equal(await evaluate(`${doc}.querySelector(".prompt button").disabled`), true);
      await act("textbox", "指令", "fill", "original");
      await click("发送");
      await waitFor('d.querySelector(".operation-state")?.textContent === "进行中"');
      const calls = await toolCalls();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].args.idempotencyKey, calls[1].args.idempotencyKey);
    });

    await t.test("theme and width preserve a draft while reset clears it", async () => {
      await open("ready");
      await act("textbox", "指令", "fill", "unsent draft");
      await act("combobox", "主题", "select", "dark");
      await act("combobox", "宽度", "select", "375");
      await waitFor('d.documentElement.dataset.theme === "dark"');
      assert.equal(await evaluate(`${doc}.querySelector("textarea").value`), "unsent draft");
      assert.equal((await toolCalls()).length, 0);
      await click("重置场景");
      await waitFor('d?.querySelector("textarea")?.value === ""');
      await act("combobox", "场景", "select", "closed");
      await waitFor('d?.querySelector(".status")?.textContent === "已关闭"');
      assert.match(await browser("get", "url"), /scene=closed/);
    });

    await t.test("compact pixel layout groups global controls, response and composer; dialogs keep safe focus", async () => {
      await open("completed");
      assert.deepEqual(await evaluate(`Array.from(${doc}.querySelectorAll("header button")).map(el => el.getAttribute("aria-label"))`), ["刷新", "列表", "关闭工作区"]);
      assert.equal(await evaluate(`${doc}.querySelector('.composer button').getAttribute('aria-label')`), "发送");
      assert.equal(await evaluate(`${doc}.querySelectorAll('main details, main footer button, .result-block h2').length`), 0);
      assert.equal(await evaluate(`${doc}.querySelector('.status span:last-child').className`), "sr-only");
      assert.ok(await evaluate(`${doc}.querySelector('main').getBoundingClientRect().height < 440`));
      assert.equal(await evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('main')).borderTopWidth`), "2px");
      assert.notEqual(await evaluate(`${doc}.defaultView.getComputedStyle(${doc}.querySelector('main')).boxShadow`), "none");
      await act("button", "刷新", "focus");
      assert.equal(await evaluate(`${doc}.defaultView.getComputedStyle(${doc}.activeElement, '::after').visibility`), "visible");
      await click("关闭工作区");
      await waitFor('d.querySelector("[role=alertdialog]")');
      assert.equal(await evaluate(`${doc}.activeElement.textContent`), "取消");
      await browser("press", "Tab");
      assert.equal(await evaluate(`${doc}.activeElement.textContent`), "关闭");
      await browser("press", "Shift+Tab");
      assert.equal(await evaluate(`${doc}.activeElement.textContent`), "取消");
      await click("取消");
    });

    await t.test("Markdown uses the host link bridge and keeps wide content inside the reply", async () => {
      await open("long-result", "&width=375");
      assert.equal(await evaluate(`${doc}.querySelector('.result h1').textContent`), "工作区检查摘要");
      assert.equal(await evaluate(`${doc}.querySelectorAll('.result img, .result script, .result iframe').length`), 0);
      assert.equal(await evaluate(`${doc}.querySelector('table').closest('.markdown-table').tabIndex`), 0);
      assert.equal(await evaluate(`${doc}.querySelector('.result pre').tabIndex`), 0);
      assert.ok(await evaluate(`${doc}.querySelector('.result pre').scrollWidth > ${doc}.querySelector('.result pre').clientWidth`));
      assert.ok(await evaluate(`${doc}.querySelector('.markdown-table').scrollWidth > ${doc}.querySelector('.markdown-table').clientWidth`));
      await act("link", "Markdown 语法说明", "click");
      await browser("wait", "--fn", 'document.querySelector("#log")?.textContent.includes("链接 → 仅记录，未打开")');
      assert.match(await browser("get", "text", "#log"), /https:\/\/commonmark.org\/help\//);
      assert.match(await browser("get", "url"), /scene=long-result/);
      assert.equal((await toolCalls()).length, 0);
      await evaluate(`(() => {
        const d = ${doc};
        window.replyRegions = [d.querySelector('.result pre'), d.querySelector('.markdown-table')];
        window.replyRegions.forEach(region => { region.scrollLeft = 40; });
        return window.replyRegions.length;
      })()`);
      await act("textbox", "指令", "fill", "unsent draft");
      const replyRegions = `Array.from(${doc}.querySelectorAll('.result pre, .markdown-table')).map((region, i) => ({ same: region === window.replyRegions[i], scroll: region.scrollLeft }))`;
      assert.deepEqual(await evaluate(replyRegions), [{ same: true, scroll: 40 }, { same: true, scroll: 40 }]);
      await click("刷新");
      await idle();
      assert.deepEqual(await evaluate(replyRegions), [{ same: true, scroll: 40 }, { same: true, scroll: 40 }]);
      assert.equal(await evaluate(`${doc}.querySelector('textarea').value`), "unsent draft");
      assert.deepEqual((await toolCalls()).map((call: {name: string}) => call.name), ["工具 → inspect_environment"]);
    });

    await t.test("semantic outcomes cannot be forged by literal logs or model JSON", async () => {
      for (const [scene, label, evidence] of [
        ["command-success", "命令成功", "退出码 0"],
        ["command-failed", "命令失败", "退出码 1"],
        ["command-cancelled", "命令已取消", "SIGKILL"],
        ["command-timeout", "命令超时", "SIGKILL"],
        ["command-truncated", "命令成功", "输出已截断"],
        ["command-historical", "命令成功", "较早的结果"],
        ["command-deceptive", "命令失败", "退出码 1"],
      ]) {
        await open(scene!, "&width=375&theme=dark");
        assert.equal(await evaluate(`${doc}.querySelector('.command-status').textContent`), label);
        assert.match(await evaluate(`${doc}.querySelector('.command-evidence').textContent`), new RegExp(evidence!));
        assert.equal(await evaluate(`${doc}.querySelector('.status').textContent`), "就绪");
        assert.equal(await evaluate(`${doc}.querySelector('pre').tabIndex`), 0);
        assert.equal((await toolCalls()).length, 0);
        if (scene === "command-deceptive") {
          assert.match(await evaluate(`${doc}.querySelector('pre').textContent`), /ORIGINAL_ERROR/);
          assert.match(await evaluate(`${doc}.querySelector('pre').textContent`), /<script>window.injected=true<\/script>/);
          assert.equal(await evaluate(`${doc}.querySelectorAll('.workspace script, .workspace img, .workspace a').length`), 0);
          assert.equal(await evaluate(`Boolean(${doc}.defaultView.injected)`), false);
        }
      }
      await open("command-truncated", "&width=375");
      await evaluate(`${doc}.querySelector('pre').focus()`);
      await browser("press", "PageDown");
      await waitFor("d.querySelector('pre').scrollTop > 0");
      // Chrome animates PageDown even with scroll-behavior:auto. Wait for the
      // keyboard scroll to settle before asserting unchanged-result continuity.
      const before = await evaluate(`new Promise(resolve => {
        const log = ${doc}.querySelector('pre');
        let last = log.scrollTop, stableFrames = 0;
        const frame = () => {
          stableFrames = log.scrollTop === last ? stableFrames + 1 : 0;
          last = log.scrollTop;
          if (stableFrames >= 12 && last > 0) resolve(last);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      })`);
      await act("textbox", "指令", "fill", "draft");
      await click("刷新");
      await idle();
      assert.equal(await evaluate(`${doc}.querySelector('pre').scrollTop`), before);
      assert.deepEqual((await toolCalls()).map((call: {name: string}) => call.name), ["工具 → inspect_environment"]);
      await open("command-historical");
      const selected = await evaluate(`${doc}.querySelector('.command-panel').dataset.operationId`);
      await click("停止");
      await waitFor('d.querySelector("[role=alertdialog]")');
      assert.equal(await evaluate(`${doc}.activeElement.textContent`), "取消");
      await browser("press", "Tab");
      assert.equal(await evaluate(`${doc}.activeElement.textContent`), "停止");
      await browser("press", "Enter");
      await idle();
      assert.equal((await toolCalls())[0].args.operationId, `task_${"a".repeat(32)}_${"b".repeat(32)}`);
      assert.notEqual((await toolCalls())[0].args.operationId, selected);
      await open("cancelled");
      assert.equal(await evaluate(`${doc}.querySelectorAll('.command-panel').length`), 0);
      assert.match(await text(), /已取消/);
      assert.match(await evaluate(`${doc}.querySelector('pre').textContent`), /PARTIAL_CANCELLED_SNAPSHOT/);
      await open("untrusted-json");
      assert.equal(await evaluate(`${doc}.querySelectorAll('.command-panel, .workspace script, .workspace img, .workspace a').length`), 0);
      assert.match(await evaluate(`${doc}.querySelector('.result').textContent`), /"status":"passed"/);
      assert.equal((await toolCalls()).length, 0);
    });

    await t.test("every scene fits desktop and narrow cards in both themes", async () => {
      for (const theme of ["light", "dark"]) for (const width of [375, 780]) for (const scene of scenes) {
        await open(scene.id, `&executor=grok&theme=${theme}&width=${width}`);
        assert.equal(await evaluate(`${doc}.documentElement.dataset.theme`), theme);
        assert.equal(await evaluate(`${doc}.documentElement.scrollWidth <= ${doc}.documentElement.clientWidth`), true, `${scene.id}/${theme}/${width}`);
        assert.doesNotMatch(await text(), /未连接到 ChatGPT|未返回工作区/);
        if (scene.id === "closed") {
          assert.doesNotMatch(await text(), /关闭时间|闲置时间|刷新不会延长使用时间/);
          assert.match(await text(), /PREVIEW_OK/);
        }
      }
    });
  } finally {
    try { await browser("close"); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
