import type { State, ToolCall, ToolResult } from "../runtime/types.ts";
import { batchCalls, testsCode } from "./batch-fixture.ts";
import { sourceCode } from "./diagnosis-fixture.ts";

export const logCall: ToolCall = {
  id: "log-1",
  name: "read_build_log",
  arguments: { path: "build.log" },
};

/** 固定日志供观察体积变化，不在本篇执行 shell 或读取磁盘。 */
export const logResult: ToolResult = {
  callId: logCall.id,
  status: "ok",
  value: {
    exitCode: 1,
    failingCase: "sum([])",
    output: "历史构建日志：空数组用例失败。\n".repeat(300),
  },
};

export const contextGoal = "结合源码和测试解释 sum([]) 报错；只诊断，不修改文件。";

/** 构造决策前的观察样本，不把样本塞进正式循环作为恢复状态。 */
export function createContextFixture(): State {
  return {
    goal: contextGoal,
    decisions: 2,
    messages: [
      { role: "user", content: contextGoal },
      { role: "assistant", action: { kind: "tool", call: structuredClone(logCall) } },
      { role: "tool", result: structuredClone(logResult) },
      { role: "assistant", action: { kind: "tools", calls: structuredClone(batchCalls) } },
      { role: "tool", result: { callId: batchCalls[0].id, status: "ok", value: sourceCode } },
      { role: "tool", result: { callId: batchCalls[1].id, status: "ok", value: testsCode } },
    ],
  };
}
