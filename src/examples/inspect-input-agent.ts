import { Agent } from "../runtime/agent.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence } from "./batch-scenario.ts";
import { scriptedInputDecide, steerText, followUpText } from "./input-scenario.ts";
import { printRunEvent } from "./trace-printer.ts";

const mode = process.argv[2] ?? "steer";
if (!["steer", "follow-up", "pause", "cancel", "budget"].includes(mode)) throw new Error("Unknown mode");
const agent = new Agent({
  decide: scriptedInputDecide,
  executeTool: createToolExecutor(createToolRegistry([readSourceTool, readTestsTool])),
  validateFinish: hasBatchEvidence,
}, { maxDecisions: mode === "budget" ? 2 : 5, run: { timeoutMs: 1000 } });

agent.subscribe(printRunEvent);

let injected = false;
agent.subscribe((event) => {
  if (event.type !== "results-recorded" || injected) return;
  injected = true;

  // 精确在两项结果写回后模拟一次用户操作，不依赖计时器碰运气。
  if (mode === "steer") agent.steer(steerText);
  if (mode === "follow-up" || mode === "budget") agent.followUp(followUpText);
  if (mode === "pause") agent.pause();
  if (mode === "cancel") { agent.pause(); agent.cancel(); }
});


const first = await agent.run("读取源码和测试片段，诊断空数组报错");
console.log(`本段结果（outcome）: ${first.outcome.status}`);
console.log(`本段决策累计（decisions）: ${first.state.decisions}`);
console.log(`是否暂停（isPaused）: ${agent.isPaused}`);

if (first.outcome.status === "paused") {
  const resumed = await agent.resume(steerText);
  console.log(`续运行结果（outcome）: ${resumed.outcome.status}`);
  console.log(`续运行决策累计（decisions）: ${resumed.state.decisions}`);
  console.log(`两次读取结果仍在（toolMessages）: ${resumed.state.messages.filter((message) => message.role === "tool").length}`);
}

const final = agent.result;
console.log(`最终消息顺序（messages）: ${final?.state.messages.map((message) => message.role).join(" -> ")}`);
if (final?.outcome.status === "completed") console.log(`最终答案（answer）: ${final.outcome.answer}`);