import type { State } from "../runtime/types.ts";
import { sourcePath, sourceCode } from "./diagnosis-fixture.ts";

export const diagnosisPrompt = [
  "你是代码诊断助手。必须先调用 read_source 读取 src/sum.ts，再根据工具结果回答。",
  "每次回复最多请求一次工具调用，不伪造工具结果，不修改文件。",
  "用中文说明 sum([]) 失败的原因，并给出最小修复建议。",
].join("\n");

/** 只检查非空答案与已确认的读取证据，不证明诊断语义正确。 */
export function hasReadEvidence(state: Readonly<State>, answer: string): boolean {
  if (!answer.trim()) return false;

  for (let index = 0; index < state.messages.length; index += 1) {
    const request = state.messages[index];
    if (request?.role !== "assistant" || request.action.kind !== "tool") continue;

    const call = request.action.call;
    if (call.name !== "read_source" || call.arguments.path !== sourcePath) continue;

    // 当前循环逐个执行工具，结果消息紧跟本次请求消息。
    const observation = state.messages[index + 1];
    if (observation?.role === "tool" && observation.result.callId === call.id &&
        observation.result.status === "ok" && observation.result.value === sourceCode) {
      return true;
    }
  }

  return false;
}
