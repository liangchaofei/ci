import type { RunEvent } from "../runtime/events.ts";

/** 将结构化报告变成中文日志；这里只显示，不驱动下一步动作。 */
export function printRunEvent(event: RunEvent): void {
  const prefix = `事件（event）#${event.seq} ${event.type}`;

  switch (event.type) {
    case "run-started":
      console.log(`${prefix}：${event.resumed ? "续运行开始" : "运行开始"}`);
      break;
    case "inputs-recorded":
      console.log(`${prefix}：写入用户消息=${event.count}，种类=${event.kinds.join(",")}，消息=${event.messages}`);
      break;
    case "decision-started":
      console.log(`${prefix}：第 ${event.decision} 次决策，输入消息=${event.inputMessages}，输入字节=${event.inputBytes}，有摘要=${event.hasSummary}`);
      break;
    case "decision-recorded":
      console.log(`${prefix}：动作=${event.kind}，调用=${event.callIds.join(",") || "无"}`);
      break;
    case "batch-started":
      console.log(`${prefix}：准备执行批次 ${event.callIds.join(",")}`);
      break;
    case "results-recorded":
      console.log(`${prefix}：已写回 ${event.callIds.join(",")}，状态=${event.statuses.join(",")}`);
      break;
    case "run-ended":
      console.log(`${prefix}：结果=${event.outcome.status}，决策=${event.decisions}，消息=${event.messages}`);
      break;
    case "run-crashed":
      console.log(`${prefix}：未预期异常=${event.reason}`);
      break;
  }
}