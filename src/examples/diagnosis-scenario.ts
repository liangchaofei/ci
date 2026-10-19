import type { Action, DecisionContext, State, ToolCall } from "../runtime/types.ts";
import { diagnosis, sourceCallId, sourceCode, sourcePath } from "./diagnosis-fixture.ts";

/** 只创建读取请求；返回这个对象不会执行读取。 */
export function createReadSourceCall(): ToolCall {
  return {
    id: sourceCallId,
    name: "read_source",
    arguments: { path: sourcePath },
  };
}

/** 按状态返回预设动作，扮演模型；不能分析任意源码。 */
export async function scriptedDecide(context: DecisionContext): Promise<Action> {
  const roles = context.messages.map((message) => message.role).join(" -> ");
  console.log(`[决策 decide] 消息角色（roles）=${roles}`);

  const lastMessage = context.messages.at(-1);
  if (lastMessage?.role === "user") {
    // 这里只提出请求，注册查找与参数检查由执行入口安排。
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