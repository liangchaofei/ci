// #region setup
import { join } from "node:path";
import { Agent } from "../runtime/agent.ts";
import { createRecoveryStore } from "../runtime/recovery-store.ts";
import { scriptedInputDecide } from "./input-scenario.ts";
import { hasBatchEvidence } from "./batch-scenario.ts";
import { prepareWorkspace, inspectWorkspace, createWorkspaceExecutor } from "./recovery-workspace.ts";

const sessionId = process.argv[2] ?? "lesson12";
const base = process.argv[3] ?? ".agent-data";
const root = join(base, "workspace12");
await prepareWorkspace(root);
const inspect = () => inspectWorkspace(root);
const store = await createRecoveryStore(base, sessionId, inspect, await inspect());
// #endregion setup

// #region run
try {
  const agent = new Agent({
    decide: scriptedInputDecide,
    executeTool: store.wrap(createWorkspaceExecutor(root)),
    validateFinish: hasBatchEvidence,
  }, { maxDecisions: 5, resultSink: store });
  agent.subscribe((event) => { if (event.type === "results-recorded") agent.pause(); });

  const result = await agent.run("读取源码和测试片段，诊断空数组报错");
  console.log(`已保存暂停（outcome）: ${result.outcome.status}`);
  console.log(`已保存消息（messages）: ${result.state.messages.length}`);
  console.log(`可检查会话（sessionId）: ${sessionId}`);
} finally {
  await store.close();
}
// #endregion run
