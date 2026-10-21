// #region imports
import { runAgentLoop } from "../runtime/agent-loop.ts";
import type { Dependencies } from "../runtime/types.ts";
import {
  hasDiagnosisEvidence,
  scriptedDecide,
} from "./diagnosis-scenario.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
// #endregion imports

// #region run
// 入口注册本次任务允许使用的工具，再组装统一执行入口。

const registry = createToolRegistry([readSourceTool]);
const executeTool = createToolExecutor(registry);
console.log(`已注册工具（tools）: ${registry.names().join(", ")}`);
const dependencies: Dependencies = {
  decide: scriptedDecide,
  executeTool,
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
for (const message of result.state.messages) {
  if (message.role === "tool") {
    console.log(`工具观察（toolResult）: ${JSON.stringify(message.result)}`);
  }
}
// #endregion run
