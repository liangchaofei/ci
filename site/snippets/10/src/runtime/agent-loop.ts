import { createRunState } from "./run-state.ts";
import type { InputBoundary, RunInbox } from "./input-queue.ts";
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
  inbox?: RunInbox;
  initialState?: Readonly<State>;
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


  // 配置与续运行状态先检查，再创建本段计时与取消资源。
  let state = createRunState(goal, options.initialState);
  const control = createRunControl(options);

  const report = createRunReporter(options.onEvent);

  // 所有正常协议出口共用这里，保证最后一份报告与返回结果一致。
  function finish(outcome: Outcome): RunResult {
    report({ type: "run-ended", outcome, decisions: state.decisions, messages: state.messages.length });
    return { state, outcome };
  }

  // 只有循环在取出输入后追加 user 消息；排队阶段没有改历史。
  // #region accept
  function acceptInputs(boundary: InputBoundary): boolean {
    control.check();
    const inputs = options.inbox?.take(boundary) ?? [];
    if (inputs.length === 0) return false;

    state = {
      ...state,
      messages: [...state.messages, ...inputs.map((input) => ({ role: "user" as const, content: input.content }))],
    };
    report({ type: "inputs-recorded", kinds: inputs.map((input) => input.kind), count: inputs.length, messages: state.messages.length });
    control.check();
    return true;
  }
  // #endregion accept

  try {
    report({ type: "run-started", resumed: options.initialState !== undefined });

    while (state.decisions < maxDecisions) {
      // #region checkpoints
      control.check();
      if (options.inbox?.isPauseRequested()) return finish({ status: "paused" });
      acceptInputs("before-decision");
      if (options.inbox?.isPauseRequested()) return finish({ status: "paused" });
      // #endregion checkpoints

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

      if (action.kind === "fail") {
        return finish(failure(action.reason, "decision"));
      }

      if (action.kind === "finish") {
        // 新要求先于旧答案的完成；暂停只发生在没有待执行工具的边界。
        // #region finish-input
        if (options.inbox?.isPauseRequested()) return finish({ status: "paused" });
        if (acceptInputs("before-decision")) continue;
        // #endregion finish-input

        try {
          // 模型的完成请求不是成功事实，必须交给应用规则核对。
          const accepted = dependencies.validateFinish(snapshot(state), action.answer);
          control.check();

          // #region follow-up
          if (accepted) {
            if (options.inbox?.isPauseRequested()) return finish({ status: "paused" });
            if (acceptInputs("before-finish")) continue;
            return finish({ status: "completed", answer: action.answer });
          }
          // #endregion follow-up

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
        results = await control.wait((signal) => {
          report({ type: "batch-started", callIds: calls.map((call) => call.id) });
          control.check();
          return runBatch(calls, signal);
        });
        control.check();
      } catch (error) {
        if (control.outcome()) throw error;
        return finish(failure(errorMessage(error), "execution"));
      }

      // 整批确认后按请求顺序追加。取消不补写已完成的一半结果。
      state = {
        ...state,
        messages: [...state.messages, ...results.map((result) => ({ role: "tool" as const, result }))],
      };
      report({
        type: "results-recorded",
        callIds: results.map((result) => result.callId),
        statuses: results.map((result) => result.status),
      });
    }

    control.check();
    return finish({ status: "budget-exhausted" });
  } catch (error) {
    const stopped = control.outcome();
    if (stopped) return finish(stopped);

    report({ type: "run-crashed", reason: errorMessage(error) });
    throw error;
  } finally {
    // 成功、失败、取消和超时都必须释放本次控制资源。
    control.dispose();
  }
}
// #endregion loop
