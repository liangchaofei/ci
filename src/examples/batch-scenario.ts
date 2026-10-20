import type { Action, DecisionContext, Message, State, ToolCall } from "../runtime/types.ts";
import { toolCallsOf } from "../runtime/action-tools.ts";
import { sourcePath, sourceCode, diagnosis } from "./diagnosis-fixture.ts";
import { testsPath, testsCode, batchCalls } from "./batch-fixture.ts";


/** 按调用 ID 匹配证据，不假定一个请求后只跟一条工具消息。 */
function hasBothReads(messages: readonly Message[]): boolean {
  const requests = new Map<string, ToolCall>();
  const verified = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of toolCallsOf(message.action)) requests.set(call.id, call);
      continue;
    }
    if (message.role !== "tool" || message.result.status !== "ok") continue;

    const call = requests.get(message.result.callId);
    if (!call) continue;
    if (call.name === "read_source" && call.arguments.path === sourcePath && message.result.value === sourceCode) {
      verified.add("read_source");
    }
    if (call.name === "read_tests" && call.arguments.path === testsPath && message.result.value === testsCode) {
      verified.add("read_tests");
    }
  }

  return verified.has("read_source") && verified.has("read_tests");
}

export const batchPrompt = [
  "你是代码诊断助手。先读取 src/sum.ts 与 test/sum.test.ts，再根据两份结果回答。",
  "这两次读取相互独立，可以在同一次响应中请求。每次最多提出 8 个调用，不伪造工具结果。",
  "用中文说明 sum([]) 失败原因及现有测试遗漏，给最小修复建议，不修改文件。",
].join("\n");

/** 仅证明两份固定读取证据与非空答案，不证明诊断语义正确。 */
export function hasBatchEvidence(state: Readonly<State>, answer: string): boolean {
  return Boolean(answer.trim()) && hasBothReads(state.messages);
}

/** 离线决策替身：提出一批读取，再根据已记录结果结束。 */
export async function scriptedBatchDecide(context: DecisionContext): Promise<Action> {
  if (context.messages.at(-1)?.role === "user") {
    return { kind: "tools", calls: structuredClone(batchCalls) };
  }

  if (hasBothReads(context.messages)) return { kind: "finish", answer: diagnosis };
  return { kind: "fail", reason: "Missing successful source or tests observation" };
}