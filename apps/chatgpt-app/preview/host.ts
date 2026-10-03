import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { PreviewSession, rejected, scenes, type Executor, type SceneId } from "./scenarios.ts";

const control = (id: string) => document.getElementById(id) as HTMLSelectElement;
const scene = control("scene");
const executor = control("executor");
const theme = control("theme");
const width = control("width");
const fault = control("fault");
const delay = control("delay");
const stage = document.getElementById("stage")!;
const log = document.getElementById("log")!;
const status = document.getElementById("bridge-status")!;
const params = new URLSearchParams(location.search);
for (const item of scenes) scene.add(new Option(item.label, item.id));
for (const [id, select] of Object.entries({ scene, executor, theme, width })) {
  const value = params.get(id);
  if ([...select.options].some(option => option.value === value)) select.value = value!;
}
let bridge: AppBridge | undefined;

function record(label: string, value: unknown) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = label;
  const body = document.createElement("pre");
  body.textContent = JSON.stringify(value, null, 2);
  item.append(title, body);
  log.append(item);
  document.getElementById("log-count")!.textContent = `${log.children.length} 条`;
}

function style() {
  const chosenTheme = theme.value === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = chosenTheme;
  stage.style.width = `min(100%, ${width.value}px)`;
  bridge?.setHostContext({ theme: chosenTheme });
  const url = new URL(location.href);
  for (const [id, select] of Object.entries({ scene, executor, theme, width })) url.searchParams.set(id, select.value);
  history.replaceState(null, "", url);
  const link = document.getElementById("link") as HTMLAnchorElement;
  link.href = url.href;
}

async function reset() {
  const previous = bridge;
  bridge = undefined;
  if (previous) await previous.close();
  log.replaceChildren();
  document.getElementById("log-count")!.textContent = "0 条";
  fault.value = "none";
  document.getElementById("hint")!.textContent = scenes.find(item => item.id === scene.value)!.hint;
  status.textContent = "正在连接正式卡片…";
  const session = new PreviewSession(scene.value as SceneId, executor.value as Executor);
  const frame = document.createElement("iframe");
  frame.title = "AgentEnv 正式卡片（本地示例数据）";
  // This loopback-only host is a UI workbench, not a replica of ChatGPT's sandbox.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  stage.replaceChildren(frame);
  const host = new AppBridge(null, { name: "AgentEnv local preview", version: "1.0.0" }, {
    serverTools: {}, message: { text: {} }, updateModelContext: {}, openLinks: {},
  }, { hostContext: { theme: theme.value === "dark" ? "dark" : "light" } });
  bridge = host;
  host.oncalltool = async ({ name, arguments: args }) => {
    const behavior = fault.value;
    const wait = Number(delay.value);
    fault.value = "none";
    record(`工具 → ${name}`, args ?? {});
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (bridge !== host) throw new Error("Preview reset");
    if (behavior === "rejected") {
      const response = rejected("INVALID_OPERATION_INPUT");
      record("回复 → 明确拒绝", response);
      return response;
    }
    const response = session.call(name, args);
    if (behavior === "unknown") {
      record("回复 → 未确认", { note: "仅模拟响应丢失；可刷新查看已接受请求的结果。" });
      throw new Error("Simulated response loss");
    }
    record("回复 → 本地示例", response);
    return response;
  };
  host.onmessage = async message => { record("对话消息 → 仅记录，未发送", message); return {}; };
  host.onopenlink = async link => { record("链接 → 仅记录，未打开", link); return {}; };
  host.onupdatemodelcontext = async () => ({});
  host.onsizechange = ({ height }) => { if (height !== undefined) frame.style.height = `${height}px`; };
  host.oninitialized = async () => {
    await host.sendToolInput({ arguments: {} });
    await host.sendToolResult(session.initial());
    status.textContent = "本地宿主已连接";
  };
  host.onerror = error => { status.textContent = `预览宿主错误：${error.message}`; };
  await host.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.src = "/workbench";
  style();
}

for (const select of [scene, executor]) select.addEventListener("change", () => { void reset(); });
for (const select of [theme, width]) select.addEventListener("change", style);
document.getElementById("reset")!.addEventListener("click", () => { void reset(); });
document.getElementById("toggle-log")!.addEventListener("click", event => {
  const button = event.currentTarget as HTMLButtonElement;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  document.getElementById("trace")!.hidden = !expanded;
});
void reset();
