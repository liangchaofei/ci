import { runAgentLoop } from "../runtime/agent-loop.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { batchPrompt, hasBatchEvidence } from "./batch-scenario.ts";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
const stream = process.argv[2] === "stream";

const registry = createToolRegistry([readSourceTool, readTestsTool]);
const decide = createDeepSeekDecider({
  apiKey,
  model,
  registry,
  systemPrompt: batchPrompt,
  stream,
  onProgress(event) {
    if (event.type === "text-delta") process.stdout.write(event.delta);
  },
});

const result = await runAgentLoop("请结合源码与已有测试，诊断 sum([]) 失败并给最小修复建议。", {
  decide,
  executeTool: createToolExecutor(registry),
  validateFinish: hasBatchEvidence,
}, 5, {
  timeoutMs: 120_000,
  toolExecution: {
    mode: "parallel",
    concurrency: 2,
    parallelSafeTools: ["read_source", "read_tests"],
  },
});

console.log(`\n运行结果（outcome）: ${result.outcome.status}`);
console.log(`决策次数（decisions）: ${result.state.decisions}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((m) => m.role).join(" -> ")}`);
if (result.outcome.status === "completed") console.log(`最终答案（answer）: ${result.outcome.answer}`);
if (result.outcome.status === "failed") console.log(`失败信息（failure）: ${result.outcome.reason}`);
