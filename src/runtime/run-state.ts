import type { State } from "./types.ts";
import { groupExchanges } from "./context-exchanges.ts";

/** 新任务初始化；续运行只接受当前程序保存的、完整交互边界上的 State。 */
export function createRunState(goal: string, previous?: Readonly<State>): State {
  if (previous === undefined) {
    return { goal, messages: [{ role: "user", content: goal }], decisions: 0 };
  }

  const state = structuredClone(previous);
  const first = state.messages[0];
  if (state.goal !== goal || first?.role !== "user" || first.content !== goal) {
    throw new Error("Resume state does not match the original goal");
  }

  const recorded = state.messages.filter((message) => message.role === "assistant").length;
  if (!Number.isSafeInteger(state.decisions) || state.decisions < 0 || state.decisions !== recorded) {
    throw new Error("Invalid decision count in resume state");
  }

  // 有工具请求却缺结果时不能续跑，避免把未知执行当作尚未执行。
  groupExchanges(state.messages.slice(1));
  return state;
}