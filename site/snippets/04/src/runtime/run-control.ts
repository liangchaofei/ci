// #region contracts
/** 一次运行的时间与外部取消配置；不放入模型 Context。 */
export type RunOptions = { signal?: AbortSignal; timeoutMs?: number };
export type StopOutcome = { status: "cancelled" } | { status: "timed-out" };

/** wait 控制等待边界，check 保护提交边界，dispose 清理本次监听与计时器。 */
export type RunControl = {
  wait: <T>(start: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  check: () => void;
  outcome: () => StopOutcome | undefined;
  dispose: () => void;
};
// #endregion contracts

// #region wait
/** 即使依赖忽略 signal，也能停止等待；依赖自身不能写 Runtime 的状态。 */
function waitForResult<T>(
  start: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  check: () => void,
): Promise<T> {
  check();

  return new Promise<T>((resolve, reject) => {
    // #region explain-abort
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    // #endregion explain-abort

    try {
      // 先完成检查和监听，再启动依赖，避免已取消时仍先执行。
      Promise.resolve(start(signal)).then(
        // #region explain-success
        (value) => {
          cleanup();

          // 启动时允许执行，不代表返回时仍允许使用结果。
          try {
            check();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        // #endregion explain-success
        (error) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
// #endregion wait

// #region create
/** 每次运行创建一份；timeoutMs 从创建时起累计，不按每次工具调用重置。 */
export function createRunControl(options: RunOptions = {}): RunControl {
  const { timeoutMs, signal: externalSignal } = options;
  if (timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) {
    throw new RangeError("timeoutMs must be an integer between 1 and 2147483647");
  }

  const controller = new AbortController();
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  let stopped: StopOutcome | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // 先保存停止原因，再通知等待者；后续停止事件不能覆盖它。
  // #region explain-stop
  function stop(outcome: StopOutcome): void {
    if (stopped) return;
    stopped = outcome;
    controller.abort(new Error("Run stopped"));
  }
  // #endregion explain-stop

  // #region explain-outcome
  function outcome(): StopOutcome | undefined {
    // 计时器无法抢占同步代码；到达下一边界时再次核对实际耗时。
    if (!stopped && deadline !== undefined && performance.now() >= deadline) {
      stop({ status: "timed-out" });
    }

    return stopped ? { ...stopped } : undefined;
  }
  // #endregion explain-outcome

  function check(): void {
    if (outcome()) throw controller.signal.reason;
  }

  // 外部取消与本次计时器共同驱动内部控制器，依赖只收到 signal。
  const cancel = () => stop({ status: "cancelled" });
  if (externalSignal?.aborted) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });

  if (!stopped && timeoutMs !== undefined) {
    timer = setTimeout(() => stop({ status: "timed-out" }), timeoutMs);
  }

  return {
    wait: (start) => waitForResult(start, controller.signal, check),
    check,
    outcome,

    // 正常或异常退出都要释放资源，不能让计时器影响后续运行。
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    },
  };
}
// #endregion create
