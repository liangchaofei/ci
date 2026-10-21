// #region setup
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "../runtime/agent.ts";
import type { RunEvent } from "../runtime/events.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence, scriptedBatchDecide } from "./batch-scenario.ts";
import { printRunEvent } from "./trace-printer.ts";

const mode = process.argv[2] ?? "normal";
if (!["normal", "reentry", "cancel", "observer", "mismatch"].includes(mode)) {
  throw new Error("Unknown mode");
}

const trace: RunEvent[] = [];
const execute = createToolExecutor(createToolRegistry([readSourceTool, readTestsTool]));
const agent = new Agent({
  decide: scriptedBatchDecide,
  async executeTool(call, signal) {
    // 给界面留出可观察的等待；真正的读取仍是前章固定片段。
    await delay(20, undefined, { signal });
    const result = await execute(call, signal);
    if (mode === "mismatch") return { ...result, callId: "wrong-id" };
    return result;
  },
  validateFinish: hasBatchEvidence,
}, {
  maxDecisions: 5,
  run: {
    timeoutMs: 1000,
    toolExecution: { mode: "parallel", concurrency: 2, parallelSafeTools: ["read_source", "read_tests"] },
  },
});
// #endregion setup

// #region observers
// 即使这位观察者破坏自己的副本并异步失败，记录器也不应受到影响。
if (mode === "observer") {
  agent.subscribe(async (event) => {
    event.seq = -1;
    if (event.type === "decision-recorded") event.callIds.length = 0;
    throw new Error("Broken observer");
  });
}

const unsubscribeTrace = agent.subscribe((event) => { trace.push(event); });
const unsubscribeDisplay = agent.subscribe(printRunEvent);
agent.subscribe((event) => {
  if (mode === "cancel" && event.type === "batch-started") agent.cancel();
});
// #endregion observers

// #region run
const pending = agent.run("读取源码和测试片段，诊断空数组报错");
console.log(`实例忙碌（isRunning）: ${agent.isRunning}`);

if (mode === "reentry") {
  try {
    await agent.run("重复点击发送的第二个任务");
  } catch (error) {
    console.log(`重复启动被拒绝（reentry）: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const result = await pending;
unsubscribeTrace();
unsubscribeDisplay();

console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`实例忙碌（isRunning）: ${agent.isRunning}`);
console.log(`保存结果（savedOutcome）: ${agent.result?.outcome.status}`);
console.log(`轨迹条数（events）: ${trace.length}`);
console.log(`顺序编号（seq）: ${trace.map((event) => event.seq).join(" -> ")}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((message) => message.role).join(" -> ")}`);
if (result.outcome.status === "failed") {
  console.log(`失败来源（source）: ${result.outcome.source}`);
}
// #endregion run
