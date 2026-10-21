import { createToolBatchRunner, validateToolBatch } from "./tool-batch.ts";
import type { ToolBatchOptions } from "./tool-batch.ts";
import { toolCallsOf, previousToolCallIds } from "./action-tools.ts";
import { createRunControl } from "./run-control.ts";
import type { RunOptions } from "./run-control.ts";
import { createContextBuilder } from "./context.ts";
import { ContextWindowError } from "./context-window.ts";
import type { ContextWindowOptions } from "./context-window.ts";
// #region helpers
import type {
  Action,
  DecisionContext,
  Dependencies,
  Outcome,
  RunResult,
  State,
  ToolResult,
} from "./types.ts";

/** 保护循环拥有的消息；当前 State 只包含可结构化复制的数据。 */
function snapshot(state: State): Readonly<State> {
  // 依赖只能改自己的副本；不能修改 Runtime 留存的消息。
  return structuredClone(state);
}

function failure(reason: string, source: "decision" | "execution" | "validation"): Outcome {
  return { status: "failed", reason, source };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
// #endregion helpers

// #region options
/** 执行调度配置独立于 RunControl，旧调用方可继续不提供。 */
export type RunAgentOptions = RunOptions & {
  toolExecution?: ToolBatchOptions;
  context?: ContextWindowOptions;
};
// #endregion options

// #region run
/**
 * 驱动一次任务，并返回最后状态与退出原因。
 * maxDecisions 限制取得 Action 的次数；一批工具仍只计一次决策。
 */
export async function runAgentLoop(
  goal: string,
  dependencies: Dependencies,
  maxDecisions: number,
  options: RunAgentOptions = {},
): Promise<RunResult> {
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1) {
    throw new RangeError("maxDecisions must be a positive integer");
  }

  const runBatch = createToolBatchRunner(dependencies.executeTool, options.toolExecution);
  const buildContext = createContextBuilder(options.context);
  const control = createRunControl(options);

  // State 只属于这次调用；再次运行会得到新的消息与计数。
  let state: State = {
    goal,
    messages: [{ role: "user", content: goal }],
    decisions: 0,
  };

  try {
    while (state.decisions < maxDecisions) {
      control.check();

      let context: DecisionContext;
      try {
        // 先准备本轮输入；装不下时不启动模型，不计一次决策。
        context = buildContext(state);
        control.check();
      } catch (error) {
        if (control.outcome()) throw error;
        if (error instanceof ContextWindowError) {
          return { state, outcome: { status: "context-limit", reason: error.message } };
        }
        return { state, outcome: failure(errorMessage(error), "decision") };
      }

      let action: Action;
      try {
        action = structuredClone(await control.wait((signal) => dependencies.decide(context, signal)));
        control.check();

        // 脚本与真实模型都必须经过运行边界，不能复用历史调用身份。
        const calls = toolCallsOf(action);
        if (calls.length > 0 || action.kind === "tools") {
          validateToolBatch(calls, previousToolCallIds(state.messages));
        }
      } catch (error) {
        if (control.outcome()) throw error;
        return { state, outcome: failure(errorMessage(error), "decision") };
      }

      // 先记下模型提出了什么，再判断能否执行或完成。
      state = {
        ...state,
        decisions: state.decisions + 1,
        messages: [...state.messages, { role: "assistant", action }],
      };
      if (action.kind === "fail") {
        return { state, outcome: failure(action.reason, "decision") };
      }

      if (action.kind === "finish") {
        try {
          // 模型的完成请求不是成功事实，必须交给应用规则核对。
          const accepted = dependencies.validateFinish(snapshot(state), action.answer);
          control.check();

          if (accepted) {
            return { state, outcome: { status: "completed", answer: action.answer } };
          }

          return { state, outcome: failure("Completion lacks verified evidence", "validation") };
        } catch (error) {
          if (control.outcome()) throw error;
          return { state, outcome: failure(errorMessage(error), "validation") };
        }
      }

      const calls = toolCallsOf(action);
      let results: ToolResult[];

      try {
        // 等待整批收齐；执行器只拿到请求副本，没有 State 引用。
        results = await control.wait((signal) => runBatch(calls, signal));
        control.check();
      } catch (error) {
        if (control.outcome()) throw error;
        return { state, outcome: failure(errorMessage(error), "execution") };
      }

      // 整批确认后按请求顺序追加。取消不补写已完成的一半结果。
      state = {
        ...state,
        messages: [...state.messages, ...results.map((result) => ({ role: "tool" as const, result }))],
      };
    }

    control.check();
    return { state, outcome: { status: "budget-exhausted" } };
  } catch (error) {
    const stopped = control.outcome();
    if (stopped) return { state, outcome: stopped };
    throw error;
  } finally {
    // 成功、失败、取消和超时都必须释放本次控制资源。
    control.dispose();
  }
}
// #endregion run
