import { setTimeout as delay } from "node:timers/promises";
import { describeFailure } from "./dependency-error.ts";
import type { Failure } from "./dependency-error.ts";

export type RetryNotice = { attempt: number; nextAttempt: number; delayMs: number; failure: Failure };
export type RetrySettings = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
  onRetry?: (notice: RetryNotice) => void;
};
export type RetryOptions = RetrySettings & {
  safety: "read-only" | "never";
  beforeAttempt?: (attempt: number) => Promise<void>;
};

/** 小范围上限让本章每项依赖的最坏尝试数可解释；整段运行还受原超时控制。 */
function checkSettings(options: RetryOptions): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5) {
    throw new RangeError("maxAttempts must be between 1 and 5");
  }
  if (!Number.isInteger(options.baseDelayMs) || options.baseDelayMs < 1 ||
      !Number.isInteger(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs || options.maxDelayMs > 60_000) {
    throw new RangeError("Invalid retry delay bounds");
  }
  if (options.safety !== "read-only" && options.safety !== "never") throw new Error("Invalid retry safety");
}

/** 只重复指定依赖调用，不重启 Agent，不写 State，也不重放一整个批次。 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
  signal: AbortSignal,
): Promise<T> {
  checkSettings(options);

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    signal.throwIfAborted();
    // 权限复核放在重试捕获之外：复核失败必须直接结束，不能当成依赖暂时失败。
    await options.beforeAttempt?.(attempt);
    signal.throwIfAborted();

    try {
      const value = await operation(attempt);
      signal.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      const failure = describeFailure(error);

      if (options.safety !== "read-only" || failure.kind !== "transient" || attempt === options.maxAttempts) {
        throw error;
      }

      const serverDelay = failure.retryAfterMs ?? 0;
      if (!Number.isFinite(serverDelay) || serverDelay < 0 || serverDelay > options.maxDelayMs) throw error;

      // 指数增长的是等待上限；随机分散实际等待，避免所有调用同时再来。
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const sample = (options.random ?? Math.random)();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError("Invalid random sample");
      const delayMs = Math.max(serverDelay, Math.floor(sample * ceiling));

      try { options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, failure: { ...failure } }); }
      catch { /* 观察者故障不改变重试结论；取消仍在下一条语句检查。 */ }
      signal.throwIfAborted();
      await delay(delayMs, undefined, { signal });
    }
  }

  throw new Error("Unreachable retry exit");
}