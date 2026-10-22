import { loadSession } from "../runtime/session-reader.ts";
import { buildDecisionContext } from "../runtime/context.ts";

const sessionId = process.argv[2] ?? "lesson11";
const base = process.argv[3] ?? ".agent-data";
const loaded = await loadSession(base, sessionId);
console.log(`日志记录数（records）: ${loaded.records.length}`);
console.log(`忽略未写完末尾（ignoredTail）: ${loaded.ignoredTail}`);
console.log(`检查点状态（checkpoint）: ${loaded.checkpointStatus}`);

if (loaded.latest) {
  const { seq, result } = loaded.latest;
  console.log(`最后已保存编号（seq）: ${seq}`);
  console.log(`最后已保存结果（outcome）: ${result.outcome.status}`);
  console.log(`累计决策（decisions）: ${result.state.decisions}`);
  console.log(`消息顺序（messages）: ${result.state.messages.map((message) => message.role).join(" -> ")}`);

  // 本篇只对已知完整暂停/完成结果重建输入，不将取消后的未知执行自动续跑。
  if (result.outcome.status === "paused" || result.outcome.status === "completed") {
    const context = buildDecisionContext(result.state);
    console.log(`可重建全量输入消息（contextMessages）: ${context.messages.length}`);
  }
}