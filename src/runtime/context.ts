import type { DecisionContext, State } from "./types.ts";
import { createContextWindow } from "./context-window.ts";
import type { ContextWindowOptions } from "./context-window.ts";

/** 每次运行准备一份构造函数；配置不提供时保留原全量行为。 */
export function createContextBuilder(options?: ContextWindowOptions): (state: Readonly<State>) => DecisionContext {
  const select = options ? createContextWindow(options) : undefined;

  return (state) => {
    if (select) return select(state.messages);
    return { messages: structuredClone(state.messages) };
  };
}

/** 保留第 2 篇的直接调用入口，仍然返回独立副本。 */
export function buildDecisionContext(state: Readonly<State>, options?: ContextWindowOptions): DecisionContext {
  return createContextBuilder(options)(state);
}