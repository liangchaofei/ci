// #region failure
export type Failure = {
  source: "transport" | "model-protocol" | "tool" | "unknown";
  kind: "transient" | "permanent" | "unknown";
  message: string;
  retryAfterMs?: number;
};

/** 只有可信适配器或工具实现能据事实分类，不能依据模型写下的 retryable。 */
export class DependencyError extends Error {
  readonly failure: Readonly<Failure>;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "DependencyError";
    this.failure = Object.freeze({ ...failure });
  }
}

/** 普通异常保守视为未知；包含 503 或 timeout 的文字不构成重试依据。 */
export function describeFailure(error: unknown): Failure {
  if (error instanceof DependencyError) return { ...error.failure };
  return { source: "unknown", kind: "unknown",
    message: error instanceof Error ? error.message : String(error) };
}
// #endregion failure
