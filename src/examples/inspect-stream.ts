import { runAgentLoop } from "../runtime/agent-loop.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSseData } from "../adapters/sse.ts";
import { collectDeepSeekAction } from "../adapters/deepseek/stream-protocol.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { hasReadEvidence } from "./deepseek-scenario.ts";
import { createToolStream } from "./stream-fixture.ts";

const mode = process.argv[2] ?? "complete";
if (!["complete", "cut", "cancel"].includes(mode)) throw new Error("Unknown stream mode");

// 外部控制器属于调用方，用来在固定的参数片段到达时取消。
const controller = new AbortController();
const executeTool = createToolExecutor(createToolRegistry([readSourceTool]));
let executions = 0;

const result = await runAgentLoop(
  "请诊断 src/sum.ts 中 sum([]) 失败的原因。",
  {
    async decide(_context, signal) {
      const events = readSseData(createToolStream(mode !== "cut"), signal);

      return collectDeepSeekAction(events, signal, (event) => {
        console.log(`暂存进度（${event.type}）: ${JSON.stringify(event.delta)}`);
        if (mode === "cancel" && event.type === "tool-arguments-delta") controller.abort();
      });
    },

    // 只统计真正进入执行器的次数，不能用进度通知代替执行证据。
    async executeTool(call, signal) {
      executions += 1;
      return executeTool(call, signal);
    },

    validateFinish: hasReadEvidence,
  },
  1,
  { signal: controller.signal, timeoutMs: 1000 },
);

// 循环结束后再显示正式状态，与前面的暂存输出区分。
console.log(`运行结果（outcome）: ${result.outcome.status}`);
console.log(`工具执行次数（executions）: ${executions}`);
console.log(`已记录决策（decisions）: ${result.state.decisions}`);
console.log(`消息顺序（messages）: ${result.state.messages.map((m) => m.role).join(" -> ")}`);

if (result.outcome.status === "failed") console.log(`失败原因（reason）: ${result.outcome.reason}`);