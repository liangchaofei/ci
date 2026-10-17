import type { Action, DecisionContext, Dependencies, State, ToolDescriptor } from "./types.ts";

/** 显式构造模型输入；次数、结果索引和轨迹不随 State 一起发送。 */
export function buildContext(
  state: Readonly<State>, tools: readonly ToolDescriptor[],
): DecisionContext {
  return {
    messages: structuredClone(state.messages),
    tools: tools.map(({ name, description }) => ({ name, description })),
  };
}

/** 将接收 Context 的决策器适配到现有 Runtime，不创建第二套循环。 */
export function createContextDecision(
  tools: readonly ToolDescriptor[],
  decideModel: (context: DecisionContext, signal: AbortSignal) => Promise<Action>,
): Dependencies["decide"] {
  // 配置在组合时取快照；每次决策仍根据最新 State 重新构造 Context。
  const descriptors = tools.map(({ name, description }) => ({ name, description }));
  return async (state, signal) => decideModel(buildContext(state, descriptors), signal);
}
