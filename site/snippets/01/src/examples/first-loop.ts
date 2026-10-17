// #region imports
import { runAgentLoop } from "../runtime/agent-loop.ts";
import type { Dependencies } from "../runtime/types.ts";
import {
  hasDiagnosisEvidence,
  scriptedDecide,
  simulateReadSource,
} from "./diagnosis-scenario.ts";
// #endregion imports

// #region run
// 入口只组装依赖；任务场景与循环调度各有自己的文件。
const dependencies: Dependencies = {
  decide: scriptedDecide,
  executeTool: simulateReadSource,
  validateFinish: hasDiagnosisEvidence,
};

const maxDecisions = 3;
const result = await runAgentLoop("Diagnose why sum([]) fails", dependencies, maxDecisions);

console.log(`outcome: ${result.outcome.status}`);
console.log(`decisions: ${result.state.decisions}`);
console.log(`messages: ${result.state.messages.map((message) => message.role).join(" -> ")}`);

if (result.outcome.status === "completed") {
  console.log(`answer: ${result.outcome.answer}`);
} else if (result.outcome.status === "failed") {
  console.log(`failure: ${result.outcome.source}: ${result.outcome.reason}`);
}
// #endregion run
