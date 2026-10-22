import type { Action, DecisionContext, State } from "../runtime/types.ts";
import { fixedSource, versionOf } from "./permission-workspace.ts";


/** 模型替身只按观察推进；文件读写与批准都是真实机制。 */
export async function permissionDecide(context: DecisionContext): Promise<Action> {
  const last = context.messages.at(-1);
  if (last?.role === "user") {
    return { kind: "tool", call: { id: "read-1", name: "read_source", arguments: { path: "sum.ts" } } };
  }
  if (last?.role !== "tool") return { kind: "fail", reason: "Missing observation" };
  if (last.result.status === "error") return { kind: "fail", reason: last.result.message };

  const value = last.result.value;
  if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") {
    return { kind: "fail", reason: "Invalid file observation" };
  }
  if (last.result.callId === "read-1") {
    return { kind: "tool", call: { id: "write-1", name: "write_source",
      arguments: { path: "sum.ts", content: fixedSource, expectedVersion: value.version } } };
  }
  return { kind: "finish", answer: "演示副本已写入初始值 0；尚未运行修复测试。" };
}

/** 只核对受限工具的写回证据；不声称已经验证任意代码修复。 */
export function hasWriteEvidence(state: Readonly<State>, answer: string): boolean {
  return answer === "演示副本已写入初始值 0；尚未运行修复测试。" && state.messages.some((message) => {
    if (message.role !== "tool" || message.result.callId !== "write-1" || message.result.status !== "ok") return false;
    const value = message.result.value;
    return value !== null && typeof value === "object" && "version" in value && value.version === versionOf(fixedSource);
  });
}