import { runAgentLoop } from "../runtime/agent-loop.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { measureContextBytes } from "../runtime/context-window.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence } from "./batch-scenario.ts";
import { logCall, logResult, contextGoal } from "./context-fixture.ts";
import { scriptedWindowDecide, summarizeBuildLog } from "./context-scenario.ts";

const mode = process.argv[2] ?? "normal";
if (!["normal", "small", "latest-large"].includes(mode)) throw new Error("Unknown mode");
let maxBytes = 14600;
if (mode === "small") maxBytes = 100;
if (mode === "latest-large") maxBytes = 1600;

const execute = createToolExecutor(createToolRegistry([readSourceTool, readTestsTool]));
let decisions = 0;
let executions = 0;

const result = await runAgentLoop(contextGoal, {
  async decide(context) {
    decisions += 1;
    console.log(`第 ${decisions} 轮输入（context）: ${context.messages.length} 条，${measureContextBytes(context)} 字节，摘要=${Boolean(context.summary)}`);
    return scriptedWindowDecide(context);
  },
  async executeTool(call, signal) {
    executions += 1;
    // 仅为本例提供已知长日志；另外两种读取仍走已有注册与检查。
    if (call.name === logCall.name) {
      if (call.arguments.path !== "build.log") throw new Error("Invalid log path");
      return { ...structuredClone(logResult), callId: call.id };
    }
    return execute(call, signal);
  },
  validateFinish: hasBatchEvidence,
}, 5, {
  context: { maxBytes, keepRecentExchanges: 1, summarize: summarizeBuildLog },
  toolExecution: { mode: "parallel", concurrency: 2, parallelSafeTools: ["read_source", "read_tests"] },
});

console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`决策次数（decisions）: ${result.state.decisions}`);
console.log(`工具启动次数（executions）: ${executions}`);
console.log(`最终历史消息数（stateMessages）: ${result.state.messages.length}`);
if (result.outcome.status === "context-limit") console.log(`输入限制原因（reason）: ${result.outcome.reason}`);
