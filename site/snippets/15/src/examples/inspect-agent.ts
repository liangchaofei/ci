import { Agent } from "../runtime/agent.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence, scriptedBatchDecide } from "./batch-scenario.ts";
import { printRunEvent } from "./trace-printer.ts";

const execute = createToolExecutor(createToolRegistry([readSourceTool, readTestsTool]));
const agent = new Agent({
  decide: scriptedBatchDecide,
  executeTool: execute,
  validateFinish: hasBatchEvidence,
}, {
  maxDecisions: 5,
  run: {
    timeoutMs: 1000,
    toolExecution: { mode: "parallel", concurrency: 2, parallelSafeTools: ["read_source", "read_tests"] },
  },
});

// 订阅必须早于启动，否则收不到已经发出的开始事件。
const unsubscribe = agent.subscribe(printRunEvent);
const pending = agent.run("读取源码和测试片段，诊断空数组报错");
console.log(`实例忙碌（isRunning）: ${agent.isRunning}`);

const result = await pending;
unsubscribe();
console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`实例忙碌（isRunning）: ${agent.isRunning}`);
console.log(`保存结果（savedOutcome）: ${agent.result?.outcome.status}`);
