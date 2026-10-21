import { createRunReporter } from "./events.ts";
import type { EventListener } from "./events.ts";
import { measureContextBytes } from "./context-window.ts";
import { createToolBatchRunner, validateToolBatch } from "./tool-batch.ts";
import type { ToolBatchOptions } from "./tool-batch.ts";
import { toolCallsOf, previousToolCallIds } from "./action-tools.ts";
import { createRunControl } from "./run-control.ts";
import type { RunOptions } from "./run-control.ts";
import { createContextBuilder } from "./context.ts";
import { ContextWindowError } from "./context-window.ts";
import type { ContextWindowOptions } from "./context-window.ts";
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

/** 执行调度配置独立于 RunControl，旧调用方可继续不提供。 */
// #region options
export type RunAgentOptions = RunOptions & {
  toolExecution?: ToolBatchOptions;
  context?: ContextWindowOptions;
  onEvent?: EventListener;
};
// #endregion options

/**
 * 驱动一次任务，并返回最后状态与退出原因。
 * maxDecisions 限制取得 Action 的次数；一批工具仍只计一次决策。
 */
// #region loop
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
  // #region explain-initialize
  let state: State = {
    goal,
    messages: [{ role: "user", content: goal }],
    decisions: 0,
  };

  const report = createRunReporter(options.onEvent);
  // #endregion explain-initialize

  // 所有正常协议出口共用这里，保证最后一份报告与返回结果一致。
  // #region explain-finish
  function finish(outcome: Outcome): RunResult {
    report({ type: "run-ended", outcome, decisions: state.decisions, messages: state.messages.length });
    return { state, outcome };
  }
  // #endregion explain-finish

  try {
    report({ type: "run-started" });

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
          return finish({ status: "context-limit", reason: error.message });
        }
        return finish(failure(errorMessage(error), "decision"));
      }

      let action: Action;
      try {
        // #region explain-decide
        action = structuredClone(await control.wait((signal) => {
          report({
            type: "decision-started",
            decision: state.decisions + 1,
            inputMessages: context.messages.length,
            inputBytes: measureContextBytes(context),
            hasSummary: context.summary !== undefined,
          });
          // 观察者可以请求取消；通知后再检查，避免仍启动依赖。
          control.check();
          return dependencies.decide(context, signal);
        }));
        control.check();
        // #endregion explain-decide

        // 脚本与真实模型都必须经过运行边界，不能复用历史调用身份。
        const calls = toolCallsOf(action);
        if (calls.length > 0 || action.kind === "tools") {
          validateToolBatch(calls, previousToolCallIds(state.messages));
        }
      } catch (error) {
        if (control.outcome()) throw error;
        return finish(failure(errorMessage(error), "decision"));
      }

      // 先记下模型提出了什么，再判断能否执行或完成。
      // #region explain-action
      state = {
        ...state,
        decisions: state.decisions + 1,
        messages: [...state.messages, { role: "assistant", action }],
      };
      report({
        type: "decision-recorded",
        decision: state.decisions,
        kind: action.kind,
        callIds: toolCallsOf(action).map((call) => call.id),
      });
      control.check();
      // #endregion explain-action

      if (action.kind === "fail") {
        return finish(failure(action.reason, "decision"));
      }

      if (action.kind === "finish") {
        try {
          // 模型的完成请求不是成功事实，必须交给应用规则核对。
          const accepted = dependencies.validateFinish(snapshot(state), action.answer);
          control.check();

          if (accepted) {
            return finish({ status: "completed", answer: action.answer });
          }

          return finish(failure("Completion lacks verified evidence", "validation"));
        } catch (error) {
          if (control.outcome()) throw error;
          return finish(failure(errorMessage(error), "validation"));
        }
      }

      const calls = toolCallsOf(action);
      let results: ToolResult[];

      try {
        // 等待整批收齐；执行器只拿到请求副本，没有 State 引用。
        // #region explain-batch
        results = await control.wait((signal) => {
          // #region explain-tool-gate
          report({ type: "batch-started", callIds: calls.map((call) => call.id) });
          control.check();
          return runBatch(calls, signal);
          // #endregion explain-tool-gate
        });
        control.check();
        // #endregion explain-batch
      } catch (error) {
        if (control.outcome()) throw error;
        return finish(failure(errorMessage(error), "execution"));
      }

      // 整批确认后按请求顺序追加。取消不补写已完成的一半结果。
      // #region explain-results
      state = {
        ...state,
        messages: [...state.messages, ...results.map((result) => ({ role: "tool" as const, result }))],
      };
      report({
        type: "results-recorded",
        callIds: results.map((result) => result.callId),
        statuses: results.map((result) => result.status),
      });
      // #endregion explain-results
    }

    control.check();
    return finish({ status: "budget-exhausted" });
  } catch (error) {
    // #region explain-stop
    const stopped = control.outcome();
    if (stopped) return finish(stopped);

    report({ type: "run-crashed", reason: errorMessage(error) });
    throw error;
    // #endregion explain-stop
  } finally {
    // 成功、失败、取消和超时都必须释放本次控制资源。
    control.dispose();
  }
}
// #endregion loop
