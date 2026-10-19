import type { Action, DecisionContext, State, ToolCall, ToolResult } from "../runtime/types.ts";


const sourcePath = "src/sum.ts";
const sourceCallId = "read-1";

/** 只创建读取请求；返回这个对象不会执行读取。 */
export function createReadSourceCall(): ToolCall {
  return {
    id: sourceCallId,
    name: "read_source",
    arguments: { path: sourcePath },
  };
}


// 固定字符串代替磁盘内容，先把运行过程变成可重复观察的过程。
const sourceCode =
  "export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);";

/** 模拟单个读取工具；只接受本例支持的名称和路径。 */
export async function simulateReadSource(call: ToolCall): Promise<ToolResult> {
  console.log(`[执行工具 execute] ${call.name} 文件路径（path）=${String(call.arguments.path)}`);

  if (call.name !== "read_source") {
    return { callId: call.id, status: "error", message: "Unsupported tool" };
  }

  if (call.arguments.path !== sourcePath) {
    return { callId: call.id, status: "error", message: "Source path is not allowed" };
  }

  return { callId: call.id, status: "ok", value: sourceCode };
}


const diagnosis = "sum([]) fails because reduce has no initial value";

/** 按状态返回预设动作，扮演模型；不能分析任意源码。 */
export async function scriptedDecide(context: DecisionContext): Promise<Action> {
  const roles = context.messages.map((message) => message.role).join(" -> ");
  console.log(`[决策 decide] 消息角色（roles）=${roles}`);

  const lastMessage = context.messages.at(-1);
  if (lastMessage?.role === "user") {
    // 复用阶段一的请求创建函数，实际执行仍由调用方安排。
    return { kind: "tool", call: createReadSourceCall() };
  }

  if (
    lastMessage?.role === "tool" &&
    lastMessage.result.callId === sourceCallId &&
    lastMessage.result.status === "ok" &&
    lastMessage.result.value === sourceCode
  ) {
    return { kind: "finish", answer: diagnosis };
  }

  return { kind: "fail", reason: "No usable source observation" };
}

/** 核对固定诊断与固定读取证据，不证明任意代码诊断正确。 */
export function hasDiagnosisEvidence(state: Readonly<State>, answer: string): boolean {
  if (answer !== diagnosis) return false;

  return state.messages.some((message) => {
    if (message.role !== "tool") return false;

    return (
      message.result.callId === sourceCallId &&
      message.result.status === "ok" &&
      message.result.value === sourceCode
    );
  });
}