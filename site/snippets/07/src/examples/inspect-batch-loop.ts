// #region tutorial-part-1
import { setTimeout as delay } from "node:timers/promises";
import { runAgentLoop } from "../runtime/agent-loop.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence, scriptedBatchDecide } from "./batch-scenario.ts";

const mode = process.argv[2] ?? "parallel";
const fault = process.argv[3] ?? "none";
if (mode !== "sequential" && mode !== "parallel") throw new Error("Unknown mode");
if (!["none", "error", "mismatch", "cancel"].includes(fault)) throw new Error("Unknown fault");

const controller = new AbortController();
const execute = createToolExecutor(createToolRegistry([readSourceTool, readTestsTool]));
let executions = 0;
// #endregion tutorial-part-1
// #region tutorial-part-2
const result = await runAgentLoop("读取源码和测试片段，诊断空数组报错", {
  decide: scriptedBatchDecide,
  async executeTool(call, signal) {
    executions += 1;
    console.log(`开始调用（start）: ${call.id}`);
    if (call.name === "read_source") await delay(20, undefined, { signal });
    if (fault === "error" && call.name === "read_tests") throw new Error("Simulated read failure");

    const result = await execute(call, signal);
    console.log(`完成调用（end）: ${call.id}`);
    if (call.name === "read_tests" && fault === "cancel") controller.abort();
    if (call.name === "read_tests" && fault === "mismatch") return { ...result, callId: "wrong-id" };
    return result;
  },
  validateFinish: hasBatchEvidence,
}, 5, {
  signal: controller.signal,
  timeoutMs: 1000,
  toolExecution: { mode, concurrency: 2, parallelSafeTools: ["read_source", "read_tests"] },
});

// #endregion tutorial-part-2
// #region tutorial-part-3
console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`决策次数（decisions）: ${result.state.decisions}`);
console.log(`工具启动次数（executions）: ${executions}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((m) => m.role).join(" -> ")}`);
const results = result.state.messages.filter((m) => m.role === "tool").map((m) => m.result);
console.log(`结果关联（callIds）: ${results.map((item) => item.callId).join(" -> ")}`);
if (result.outcome.status === "failed") console.log(`失败来源（source）: ${result.outcome.source}`);
// #endregion tutorial-part-3
