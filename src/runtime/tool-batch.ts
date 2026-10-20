import type { Dependencies, ToolCall, ToolResult } from "./types.ts";

/** 教学实现的单次动作上限；不是模型服务的统一限制。 */
export const maxToolCallsPerDecision = 8;

export type ToolBatchOptions = {
  mode?: "sequential" | "parallel";
  concurrency?: number;
  parallelSafeTools?: readonly string[];
};

/** 整批身份与参数形状先检查，避免执行到一半才发现重复调用。 */
export function validateToolBatch(calls: readonly ToolCall[], previousIds: Iterable<string> = []): void {
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > maxToolCallsPerDecision) {
    throw new Error("Tool batch must contain 1 to 8 calls");
  }

  const seen = new Set(previousIds);
  for (const call of calls) {
    if (typeof call !== "object" || call === null ||
        typeof call.id !== "string" || !call.id.trim() ||
        typeof call.name !== "string" || !call.name.trim()) {
      throw new Error("Invalid tool call identity");
    }

    if (seen.has(call.id)) throw new Error("Duplicate tool call id in run");
    seen.add(call.id);

    if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
      throw new Error("Tool arguments must be an object");
    }
  }
}


/** 调度一批已知请求；只返回结果，不接触 State，也不自动重试。 */
export function createToolBatchRunner(
  executeTool: Dependencies["executeTool"],
  options: ToolBatchOptions = {},
): (calls: readonly ToolCall[], signal: AbortSignal) => Promise<ToolResult[]> {
  const mode = options.mode ?? "sequential";
  const concurrency = options.concurrency ?? 2;
  if (mode !== "sequential" && mode !== "parallel") throw new Error("Invalid tool execution mode");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxToolCallsPerDecision) {
    throw new RangeError("concurrency must be an integer between 1 and 8");
  }

  // 这份声明来自应用配置，模型参数不能把自己声明成可并行。
  const safeNames = new Set(options.parallelSafeTools ?? []);

  return async (calls, signal) => {
    signal.throwIfAborted();
    validateToolBatch(calls);
    const requests = structuredClone(calls);

    // 本批含任何未声明安全的工具，就整批退回顺序执行。
    const parallel = mode === "parallel" && requests.every((call) => safeNames.has(call.name));
    const workerCount = parallel ? Math.min(concurrency, requests.length) : 1;
    const results: ToolResult[] = new Array(requests.length);
    let nextIndex = 0;
    let fatal: Error | undefined;

    async function worker(): Promise<void> {
      while (!fatal) {
        signal.throwIfAborted();

        // 领取编号的过程不含 await；同一运行中的两个 worker 不会领取同一项。
        const index = nextIndex;
        nextIndex += 1;
        if (index >= requests.length) return;
        const call = requests[index];

        let result: ToolResult;
        try {
          result = structuredClone(await executeTool(structuredClone(call), signal));
        } catch (error) {
          signal.throwIfAborted();
          result = {
            callId: call.id,
            status: "error",
            code: "tool-error",
            message: error instanceof Error ? error.message : String(error),
          };
        }

        signal.throwIfAborted();
        if (typeof result !== "object" || result === null || result.callId !== call.id) {
          // 关联已不可信：不把它伪装成本次调用的普通失败观察。
          fatal = new Error("Tool result callId does not match the request");
          return;
        }

        // 写回领取时的下标，而不是完成时 push，才能保持请求顺序。
        results[index] = result;
      }
    }

    // 等待的是有限个 worker；每个 worker 完成一项后才领取下一项。
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    signal.throwIfAborted();
    if (fatal) throw fatal;
    return results;
  };
}