import type { RunOptions } from "./types.ts";

/** 只用于 Runtime 自己的停止请求，不能靠错误消息猜测取消原因。 */
export class RunStopped extends Error {
  readonly status: "cancelled" | "timed-out";
  constructor(status: "cancelled" | "timed-out") {
    super(status);
    this.status = status;
  }
}

/** 为单次运行建立时间与取消边界，返回后必须 dispose。 */
export function createRunControl(options: RunOptions) {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error("timeoutMs must be an integer between 1 and 2147483647");
  }

  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let stopped: RunStopped | null = null;

  const stop = (status: "cancelled" | "timed-out") => {
    // 首个停止原因生效，稍后的超时不能覆盖用户取消。
    if (stopped !== null) return;
    stopped = new RunStopped(status);
    controller.abort(stopped);
  };
  const onCallerAbort = () => stop("cancelled");
  if (options.signal?.aborted) {
    onCallerAbort();
  } else {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => stop("timed-out"), timeoutMs);

  const check = () => {
    // 同步计算阻塞事件循环时，计时器可能晚触发；回到控制边界再核对时钟。
    if (stopped === null && performance.now() >= deadline) stop("timed-out");
    if (stopped !== null) throw stopped;
  };

  /** 可停止等待，并把信号传给依赖；不能强制终止外部副作用。 */
  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(stopped);
      };
      const cleanup = () => controller.signal.removeEventListener("abort", onAbort);
      controller.signal.addEventListener("abort", onAbort, { once: true });

      // 同时接住依赖的成功与失败；停止后的迟到拒绝不会变成未处理异常。
      Promise.resolve().then(() => {
        check();
        return operation();
      }).then(
        (value) => {
          cleanup();
          try {
            check();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        (error: unknown) => {
          cleanup();
          // 依赖响应取消时可能抛 AbortError，以本次运行的停止事实为准。
          reject(stopped ?? error);
        },
      );
    });
  };

  return {
    signal: controller.signal,
    check,
    wait,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}