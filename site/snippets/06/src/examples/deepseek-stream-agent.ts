// #region tutorial-part-1
import { runAgentLoop } from "../runtime/agent-loop.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { diagnosisPrompt, hasReadEvidence } from "./deepseek-scenario.ts";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");

const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";

// #endregion tutorial-part-1
// #region tutorial-part-2
// 同一份注册表同时连接模型可见说明与本地执行入口。
const registry = createToolRegistry([readSourceTool]);
const decide = createDeepSeekDecider({
  apiKey, model, registry, systemPrompt: diagnosisPrompt,
  stream: true,

  // 进度只用于显示，不在这里执行工具或追加会话消息。
  onProgress(event) {
    if (event.type === "text-delta") process.stdout.write(event.delta);
  },
});

// #endregion tutorial-part-2
// #region tutorial-part-3
const result = await runAgentLoop(
  "请诊断 src/sum.ts 中 sum([]) 失败的原因，并给出最小修复建议。",
  { decide, executeTool: createToolExecutor(registry), validateFinish: hasReadEvidence },
  5,
  { timeoutMs: 120_000 },
);

// #endregion tutorial-part-3
// #region tutorial-part-4
// 此处才取得运行结果；前面已经显示的文字可能仍属于失败的决策。
console.log(`\n运行结果（outcome）: ${result.outcome.status}`);
console.log(`决策次数（decisions）: ${result.state.decisions}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((m) => m.role).join(" -> ")}`);

if (result.outcome.status === "completed") {
  console.log(`最终答案（answer）: ${result.outcome.answer}`);
} else if (result.outcome.status === "failed") {
  console.log(`失败信息（failure）: ${result.outcome.source}: ${result.outcome.reason}`);
}
// #endregion tutorial-part-4
