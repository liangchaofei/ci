import type { RunResult } from "./types.ts";

/** 必须等待的结果保存接口；不依赖文件系统，也不是事件订阅者。 */
export type ResultSink = {
  save: (runId: string, result: Readonly<RunResult>) => Promise<void>;
};

/** 循环可能已完成，但必须完成的保存失败，调用方不能按成功保存处理。 */
export class ResultSaveError extends Error {
  constructor(cause: unknown) {
    super("Run ended, but saving its result failed", { cause });
    this.name = "ResultSaveError";
  }
}
