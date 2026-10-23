import { Agent } from "../runtime/agent.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { batchPrompt, hasBatchEvidence } from "./batch-scenario.ts";
import { followUpText } from "./input-scenario.ts";
import { printRunEvent } from "./trace-printer.ts";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
const registry = createToolRegistry([readSourceTool, readTestsTool]);
const agent = new Agent({
  decide: createDeepSeekDecider({
    apiKey,
    model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
    registry,
    systemPrompt: batchPrompt,
  }),
  executeTool: createToolExecutor(registry),
  validateFinish: hasBatchEvidence,
}, { maxDecisions: 8, run: { timeoutMs: 120_000, context: { maxBytes: 18000 } } });

agent.subscribe(printRunEvent);
let queued = false;
agent.subscribe((event) => {
  if (event.type === "results-recorded" && !queued) {
    queued = true;
    agent.followUp(followUpText);
  }
});

const result = await agent.run("请结合源码与测试，诊断 sum([]) 报错并给最小修复建议。");
console.log(`运行结果（outcome）: ${result.outcome.status}`);
if (result.outcome.status === "completed") console.log(`最终答案（answer）: ${result.outcome.answer}`);
if (result.outcome.status === "failed") console.log(`失败原因（reason）: ${result.outcome.reason}`);
