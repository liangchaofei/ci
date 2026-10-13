import type {
  Dependencies, Event, Outcome, RunResult, State, Task,
} from "./types.ts";

/**
 * 驱动一次内存读取任务。
 * task 是目标，dependencies 提供决策与执行，maxDecisions 限制决策调用次数。
 * 配置非法时抛错；运行失败时返回 failed；只有证据匹配才能 completed。
 */
export async function runAgentLoop(
  task: Task,
  dependencies: Dependencies,
  maxDecisions: number,
): Promise<RunResult> {
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1) {
    throw new Error("maxDecisions must be a positive safe integer");
  }

  // 每次运行都创建自己的状态和事件数组。
  let state: State = { ...task, observation: null, decisions: 0 };
  const events: Event[] = [];
  const end = (outcome: Outcome): RunResult => ({ outcome, state, events });

  // 在请求下一次决策之前检查额度，避免多调用一次。
  while (state.decisions < maxDecisions) {
    state = { ...state, decisions: state.decisions + 1 };
    try {
      // 副本隔开本例中的状态所有权；不是通用深拷贝或安全沙箱。
      const view: State = {
        ...state,
        observation: state.observation ? { ...state.observation } : null,
      };
      // 决策器只提出请求，循环负责分流与执行。
      const action = await dependencies.decide(view);
      events.push({ kind: "decision", index: state.decisions, action: { ...action } });

      if (action.kind === "fail") {
        return end({ status: "failed", reason: action.reason });
      }

      if (action.kind === "finish") {
        const evidence = state.observation;
        // 完成请求必须与当前任务的成功观察对应。
        if (
          evidence?.kind !== "read-ok" ||
          evidence.path !== task.targetPath ||
          evidence.content !== action.answer
        ) {
          return end({ status: "failed", reason: "Finish lacks matching evidence" });
        }
        return end({ status: "completed", answer: action.answer });
      }

      // 本章只允许目标文件，不能用其他文件的结果完成任务。
      if (action.path !== task.targetPath) {
        return end({ status: "failed", reason: "Read is outside task scope" });
      }
      const raw = await dependencies.executeRead({ ...action });
      // 结果必须属于本次请求，不能用另一文件的内容更新状态。
      if (raw.path !== action.path) {
        return end({ status: "failed", reason: "Observation path mismatch" });
      }
      const observation = { ...raw };
      events.push({ kind: "observation", observation: { ...observation } });
      // 必须先更新，再进入下一次决策。
      state = { ...state, observation };
    } catch (error) {
      // 将决策或执行异常转为失败；下一章再细分取消和超时。
      const reason = error instanceof Error ? error.message : String(error);
      return end({ status: "failed", reason });
    }
  }

  return end({ status: "budget-exhausted" });
}