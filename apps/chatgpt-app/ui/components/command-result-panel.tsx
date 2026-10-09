import type { CommandPresentation } from "../semantic-presentation.ts";
import { Icon } from "./icon.tsx";

const labels = { passed: "命令成功", failed: "命令失败", cancelled: "命令已取消", "timed-out": "命令超时" };

function EvidenceRow({ evidence: e }: { evidence: CommandPresentation["evidence"] }) {
  return <p className="command-evidence">
    <span>来源：Runner 命令</span>
    {e.exitCode !== null && <span>退出码 {e.exitCode}</span>}
    {e.signal && <span>信号 {e.signal}</span>}
    {e.truncated && <span>输出已截断</span>}
    {e.historical && <span>较早的结果</span>}
  </p>;
}

/** Only the deterministic selector supplies this panel; logs remain separate literal text. */
export function CommandResultPanel({ presentation: p }: { presentation: CommandPresentation }) {
  const icon = p.status === "passed" ? "check" : p.status === "failed" ? "cross"
    : p.status === "cancelled" ? "stop" : "clock";
  return <section className={`command-panel ${p.status}`} aria-label="命令结果" data-operation-id={p.evidence.operationId}>
    <div className="command-status" role="status"><Icon name={icon} /><strong>{labels[p.status]}</strong></div>
    <EvidenceRow evidence={p.evidence} />
  </section>;
}
