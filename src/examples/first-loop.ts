import { runAgentLoop } from "../runtime/agent-loop.ts";
import type { Dependencies } from "../runtime/types.ts";
import {
  hasDiagnosisEvidence,
  scriptedDecide,
  simulateReadSource,
} from "./diagnosis-scenario.ts";

// 入口只组装依赖；任务场景与循环调度各有自己的文件。
const dependencies: Dependencies = {
  decide: scriptedDecide,
  executeTool: simulateReadSource,
  validateFinish: hasDiagnosisEvidence,
};

const maxDecisions = 3;
const result = await runAgentLoop("Diagnose why sum([]) fails", dependencies, maxDecisions);

console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`决策次数（decisions）: ${result.state.decisions}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((message) => message.role).join(" -> ")}`);

if (result.outcome.status === "completed") {
  console.log(`最终答案（answer）: ${result.outcome.answer}`);
} else if (result.outcome.status === "failed") {
  console.log(`失败信息（failure）: ${result.outcome.source}: ${result.outcome.reason}`);
}