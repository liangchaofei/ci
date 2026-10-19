// #region initialize
import { scriptedDecide, simulateReadSource } from "./diagnosis-scenario.ts";
import type { State } from "../runtime/types.ts";

// 这个阶段手动走两次决策，先观察反馈，不宣称任务已验证完成。
const goal = "Diagnose why sum([]) fails";
let state: State = {
  goal,
  messages: [{ role: "user", content: goal }],
  decisions: 0,
};
// #endregion initialize

// #region first_turn
const firstAction = await scriptedDecide(state);
state = {
  ...state,
  decisions: state.decisions + 1,
  messages: [...state.messages, { role: "assistant", action: firstAction }],
};

// 本阶段只演示先读源码的路径；不满足前提时停止演示。
if (firstAction.kind !== "tool") {
  throw new Error("This checkpoint expects a tool action first");
}

const result = await simulateReadSource(firstAction.call);
// 关键的一步：工具返回的值不会自动进入消息，必须显式写入。
state = { ...state, messages: [...state.messages, { role: "tool", result }] };
// #endregion first_turn

// #region next_turn
const nextAction = await scriptedDecide(state);
state = {
  ...state,
  decisions: state.decisions + 1,
  messages: [...state.messages, { role: "assistant", action: nextAction }],
};

console.log(`下一步动作（next-action）: ${nextAction.kind}`);
console.log(`决策次数（decisions）: ${state.decisions}`);
console.log(`消息顺序（messages）: ${state.messages.map((message) => message.role).join(" -> ")}`);
if (nextAction.kind === "finish") {
  console.log(`候选答案（proposed-answer）: ${nextAction.answer}`);
}
// #endregion next_turn
