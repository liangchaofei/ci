/** 由实验明确决定何时返回，不用“睡几十毫秒”猜并发顺序。 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 让已经安排的 Promise 回调有机会完成，不代表增加业务等待时间。 */
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));