// #region inspect
import { join } from "node:path";
import { Agent } from "../runtime/agent.ts";
import { inspectRecovery } from "../runtime/recovery-reader.ts";
import { createRecoveryStore } from "../runtime/recovery-store.ts";
import { inspectWorkspace, createWorkspaceExecutor } from "./recovery-workspace.ts";
import { scriptedInputDecide, steerText } from "./input-scenario.ts";
import { hasBatchEvidence } from "./batch-scenario.ts";

const sourceId = process.argv[2] ?? "lesson12";
const targetId = process.argv[3] ?? "lesson12-resumed";
const base = process.argv[4] ?? ".agent-data";
const root = join(base, "workspace12");
const inspect = () => inspectWorkspace(root);
const decision = await inspectRecovery(base, sourceId, await inspect());
console.log(`恢复检查（status）: ${decision.status}`);
// #endregion inspect

// #region resume
if (decision.status === "blocked") {
  console.log(`停止原因（reason）: ${decision.reason}`);
  console.log(`待核查调用（intents）: ${decision.intents.map((item) => item.id).join(", ") || "无可确认清单"}`);
} else {
  // 新会话保存续运行，不修改旧会话；begin 会在实际启动前再检查资源版本。
  const store = await createRecoveryStore(base, targetId, inspect, decision.environment);
  let executions = 0;
  const execute = createWorkspaceExecutor(root);
  try {
    const agent = new Agent({
      decide: scriptedInputDecide,
      executeTool: store.wrap(async (call, signal) => { executions += 1; return execute(call, signal); }),
      validateFinish: hasBatchEvidence,
    }, { maxDecisions: 5, resultSink: store });
    // #region install
    agent.restore(decision.result);
    const result = await agent.resume(steerText);
    // #endregion install

    console.log(`续运行结果（outcome）: ${result.outcome.status}`);
    console.log(`累计决策（decisions）: ${result.state.decisions}`);
    console.log(`消息顺序（messages）: ${result.state.messages.map((message) => message.role).join(" -> ")}`);
    console.log(`本进程工具执行（executions）: ${executions}`);
  } finally {
    await store.close();
  }
}
// #endregion resume
