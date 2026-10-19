import type { DecisionContext, State } from "./types.ts";

/** 每次决策前，从最新状态准备一份独立的输入。 */
export function buildDecisionContext(state: Readonly<State>): DecisionContext {
  // 明确选择消息；不把 goal、decisions 等顶层控制字段一并交出。
  return { messages: structuredClone(state.messages) };
}