import type { Dependencies, Event, Outcome, RunOptions, RunResult, State, Task } from "./types.ts";
import { createRunControl, RunStopped } from "./run-control.ts";

/** 通用调度不再理解文件路径或答案格式，任务规则由应用验证。 */
export async function runAgentLoop(
  task: Task, dependencies: Dependencies, maxDecisions: number, options: RunOptions = {},
): Promise<RunResult> {
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1) {
    throw new Error("maxDecisions must be a positive safe integer");
  }
  const control = createRunControl(options);
  let state: State = {
    ...task, observations: [], decisions: 0,
    messages: [{ role: "user", content: task.goal }],
  };
  const events: Event[] = [];
  const usedCallIds = new Set<string>();
  const end = (outcome: Outcome): RunResult => ({ outcome, state, events });
  let source: "decision" | "execution" | "validation" = "decision";
  try {
    control.check();
    while (state.decisions < maxDecisions) {
      control.check();
      state = { ...state, decisions: state.decisions + 1 };
      source = "decision";
      // 当前工具结果为 JSON 数据，复制视图以避免依赖直接改任务现场。
      const action = await control.wait(() => dependencies.decide(structuredClone(state), control.signal));
      control.check();
      events.push({ kind: "decision", index: state.decisions, action: structuredClone(action) });
      // 只记录已接纳的完整动作；取消后的迟到响应不能进入记录。
      state = { ...state, messages: [...state.messages,
        { role: "assistant", action: structuredClone(action) }] };
      if (action.kind === "fail") return end({ status: "failed", reason: action.reason });
      if (action.kind === "finish") {
        source = "validation";
        const valid = dependencies.validateFinish(structuredClone(state), action.answer);
        control.check();
        return valid
          ? end({ status: "completed", answer: action.answer })
          : end({ status: "failed", reason: "Finish lacks matching evidence" });
      }
      const call = structuredClone(action.call);
      if (!call.id.trim() || usedCallIds.has(call.id)) {
        return end({ status: "failed", reason: "Call id must be nonempty and unique" });
      }
      usedCallIds.add(call.id);
      source = "execution";
      const raw = await control.wait(() => dependencies.executeToolCall(structuredClone(call), control.signal));
      control.check();
      if (raw.callId !== call.id || raw.toolName !== call.name) {
        return end({ status: "failed", reason: "Tool result does not match call" });
      }
      const observation = structuredClone(raw);
      events.push({ kind: "observation", observation: structuredClone(observation) });
      // 失败工具结果也保存，下一次决策才能据此修正或结束。
      state = { ...state, observations: [...state.observations, observation],
        messages: [...state.messages, { role: "tool", result: structuredClone(observation) }] };
    }
    control.check();
    return end({ status: "budget-exhausted" });
  } catch (error) {
    if (error instanceof RunStopped) return end({ status: error.status });
    const reason = error instanceof Error ? error.message : String(error);
    return end({ status: "failed", reason, source });
  } finally {
    control.dispose();
  }
}
