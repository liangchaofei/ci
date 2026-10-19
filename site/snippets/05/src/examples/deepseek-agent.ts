import { runAgentLoop } from "../runtime/agent-loop.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { diagnosisPrompt, hasReadEvidence } from "./deepseek-scenario.ts";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
const registry = createToolRegistry([readSourceTool]);
const decide = createDeepSeekDecider({ apiKey, model, registry, systemPrompt: diagnosisPrompt });
const result = await runAgentLoop(
  "请诊断 src/sum.ts 中 sum([]) 失败的原因，并给出最小修复建议。",
  { decide, executeTool: createToolExecutor(registry), validateFinish: hasReadEvidence },
  5,
  { timeoutMs: 120_000 },
);
console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`决策次数（decisions）: ${result.state.decisions}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((m) => m.role).join(" -> ")}`);
if (result.outcome.status === "completed") {
  console.log(`模型答案（answer）: ${result.outcome.answer}`);
} else if (result.outcome.status === "failed") {
  console.log(`失败信息（failure）: ${result.outcome.source}: ${result.outcome.reason}`);
}
