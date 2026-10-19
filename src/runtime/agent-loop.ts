import { buildDecisionContext } from "./context.ts";
import type {
  Action,
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

/**
 * 驱动一次任务，并返回最后状态与退出原因。
 * maxDecisions 限制取得 Action 的次数；一次决策最多请求一个工具。
 */
export async function runAgentLoop(
  goal: string,
  dependencies: Dependencies,
  maxDecisions: number,
): Promise<RunResult> {
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1) {
    throw new RangeError("maxDecisions must be a positive integer");
  }

  // State 只属于这次调用；再次运行会得到新的消息与计数。
  let state: State = {
    goal,
    messages: [{ role: "user", content: goal }],
    decisions: 0,
  };

  while (state.decisions < maxDecisions) {
    let action: Action;
    try {
    // 每轮都重新构造，才能包含上一轮刚写回的工具结果。
    const context = buildDecisionContext(state);
    action = structuredClone(await dependencies.decide(context));
    } catch (error) {
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
        if (dependencies.validateFinish(snapshot(state), action.answer)) {
          return { state, outcome: { status: "completed", answer: action.answer } };
        }
        return { state, outcome: failure("Completion lacks verified evidence", "validation") };
      } catch (error) {
        return { state, outcome: failure(errorMessage(error), "validation") };
      }
    }
    let result: ToolResult;
    try {
      result = structuredClone(await dependencies.executeTool(structuredClone(action.call)));
    } catch (error) {
      // 执行错误也是观察，下一轮决策需要知道这次调用失败了。
      result = { callId: action.call.id, status: "error", message: errorMessage(error) };
    }

    // 一个调用的结果不能写到另一个调用名下。
    if (result.callId !== action.call.id) {
      return {
        state,
        outcome: failure("Tool result callId does not match the request", "execution"),
      };
    }
    // 只有确认属于本次调用的结果才能进入 State，供下一轮 decide 使用。
    state = { ...state, messages: [...state.messages, { role: "tool", result }] };
  }

  return { state, outcome: { status: "budget-exhausted" } };
}