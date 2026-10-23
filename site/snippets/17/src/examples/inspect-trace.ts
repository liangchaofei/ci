import { runAgentLoop } from "../runtime/agent-loop.ts";
import type { RunEvent } from "../runtime/events.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence, scriptedBatchDecide } from "./batch-scenario.ts";
import { printRunEvent } from "./trace-printer.ts";

const trace: RunEvent[] = [];
const execute = createToolExecutor(createToolRegistry([readSourceTool, readTestsTool]));

const result = await runAgentLoop("读取源码和测试片段，诊断空数组报错", {
  decide: scriptedBatchDecide,
  executeTool: execute,
  validateFinish: hasBatchEvidence,
}, 5, {
  timeoutMs: 1000,
  toolExecution: { mode: "parallel", concurrency: 2, parallelSafeTools: ["read_source", "read_tests"] },
  onEvent(event) {
    trace.push(event);
    printRunEvent(event);
  },
});

console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`轨迹顺序（trace）: ${trace.map((event) => event.type).join(" -> ")}`);
