import type { Action, DecisionContext } from "../runtime/types.ts";
import { batchCalls } from "./batch-fixture.ts";
import { hasBothReads } from "./batch-scenario.ts";

export const steerText = "请用中文说明原因，只诊断，不修改文件。";
export const followUpText = "再说明现有测试遗漏了什么。";

/** 固定场景替身：只有第一次请求读取，后续输入用已有证据回答。 */
export async function scriptedInputDecide(context: DecisionContext): Promise<Action> {
  const hasRequest = context.messages.some((message) => message.role === "assistant");
  if (!hasRequest) return { kind: "tools", calls: structuredClone(batchCalls) };

  // 按原调用身份与固定内容检查已有证据，不为每次追加输入重复读取。
  if (!hasBothReads(context.messages)) return { kind: "fail", reason: "Missing fixed reading evidence" };

  const users = context.messages.filter((message) => message.role === "user");
  if (users.some((message) => message.content === followUpText)) {
    return { kind: "finish", answer: "现有测试只覆盖非空数组，遗漏了 sum([])；应补上空数组用例。" };
  }
  if (users.some((message) => message.content === steerText)) {
    return { kind: "finish", answer: "空数组调用 reduce 时没有初始值，因此报错；本次只诊断，未修改文件。" };
  }

  return { kind: "finish", answer: "sum([]) fails because reduce has no initial value" };
}