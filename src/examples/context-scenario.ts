import type { Action, DecisionContext, Message } from "../runtime/types.ts";
import { toolCallsOf } from "../runtime/action-tools.ts";
import { batchCalls } from "./batch-fixture.ts";
import { logCall } from "./context-fixture.ts";
import { diagnosis } from "./diagnosis-fixture.ts";


/** 只提取本例已省略日志的结构化事实；不是通用文本或模型摘要器。 */
export function summarizeBuildLog(messages: readonly Message[]): string {
  const logIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of toolCallsOf(message.action)) {
        if (call.name === logCall.name && call.arguments.path === "build.log") logIds.add(call.id);
      }
      continue;
    }
    if (message.role !== "tool" || message.result.status !== "ok" || !logIds.has(message.result.callId)) continue;

    const value = message.result.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const fact = value as Record<string, unknown>;
    if (fact.exitCode === 1 && fact.failingCase === "sum([])") {
      return "较早的构建日志：退出码为 1，失败用例为 sum([])。这是历史诊断线索，不表示已修复。";
    }
  }

  return "";
}

/** 离线走三轮：先取得长日志，再读源码与测试，最后给固定诊断。 */
export async function scriptedWindowDecide(context: DecisionContext): Promise<Action> {
  const last = context.messages.at(-1);
  if (last?.role === "user") return { kind: "tool", call: structuredClone(logCall) };

  if (last?.role === "tool" && last.result.callId === logCall.id) {
    return { kind: "tools", calls: structuredClone(batchCalls) };
  }

  if (last?.role === "tool" && last.result.callId === batchCalls[1].id && context.summary) {
    return { kind: "finish", answer: diagnosis };
  }

  return { kind: "fail", reason: "Expected recent reads and earlier log summary" };
}