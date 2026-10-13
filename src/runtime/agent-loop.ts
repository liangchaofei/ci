import type {
  Dependencies, Event, Outcome, RunOptions, RunResult, State, Task,
} from "./types.ts";
import { createRunControl, RunStopped } from "./run-control.ts";

/** 保留第 1 篇反馈链，增加整次运行的时间预算与取消信号。 */
export async function runAgentLoop(
  task: Task,
  dependencies: Dependencies,
  maxDecisions: number,
  options: RunOptions = {},
): Promise<RunResult> {
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1) {
    throw new Error("maxDecisions must be a positive safe integer");
  }
  const control = createRunControl(options);
  let state: State = { ...task, observation: null, decisions: 0 };
  const events: Event[] = [];
  const end = (outcome: Outcome): RunResult => ({ outcome, state, events });
  let source: "decision" | "execution" = "decision";

  try {
    control.check();
    while (state.decisions < maxDecisions) {
      control.check();
      state = { ...state, decisions: state.decisions + 1 };
      const view: State = {
        ...state,
        observation: state.observation ? { ...state.observation } : null,
      };
      source = "decision";
      const action = await control.wait(() => dependencies.decide(view, control.signal));
      // await 后再次检查，取消与返回同时发生时不能继续执行。
      control.check();
      events.push({ kind: "decision", index: state.decisions, action: { ...action } });
      if (action.kind === "fail") {
        return end({ status: "failed", reason: action.reason });
      }
      if (action.kind === "finish") {
        const evidence = state.observation;
        if (
          evidence?.kind !== "read-ok" ||
          evidence.path !== task.targetPath ||
          evidence.content !== action.answer
        ) {
          return end({ status: "failed", reason: "Finish lacks matching evidence" });
        }
        return end({ status: "completed", answer: action.answer });
      }
      if (action.path !== task.targetPath) {
        return end({ status: "failed", reason: "Read is outside task scope" });
      }
      source = "execution";
      const raw = await control.wait(() =>
        dependencies.executeRead({ ...action }, control.signal));
      control.check();
      if (raw.path !== action.path) {
        return end({ status: "failed", reason: "Observation path mismatch" });
      }
      const observation = { ...raw };
      events.push({ kind: "observation", observation: { ...observation } });
      state = { ...state, observation };
    }
    control.check();
    return end({ status: "budget-exhausted" });
  } catch (error) {
    if (error instanceof RunStopped) return end({ status: error.status });
    const reason = error instanceof Error ? error.message : String(error);
    return end({ status: "failed", reason, source });
  } finally {
    // 成功、失败或停止都清理本次定时器和调用方监听器。
    control.dispose();
  }
}