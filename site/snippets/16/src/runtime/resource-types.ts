// #region contracts
export type ResourceKind = "model-requests" | "model-concurrency" | "known-tokens" | "estimated-cost";
export type ResourceLimits = {
  maxRequests: number;
  maxConcurrent: number;
  maxKnownTokens: number;
  maxEstimatedCostUnits: number;
};
export type TokenUsage = { inputTokens: number; outputTokens: number };
/** 演示用整数计价单位；由应用配置，不是实时价格或服务账单。 */
export type UsageRates = { inputUnitsPerToken: number; outputUnitsPerToken: number };
export type UsageTotals = TokenUsage & { knownTokens: number; estimatedCostUnits: number };
export type BudgetSnapshot = UsageTotals & {
  requests: number;
  active: number;
  peak: number;
  unreportedRequests: number;
};

/** 与用户取消、运行超时及决策次数耗尽区分。 */
export class ResourceLimitError extends Error {
  readonly resource: ResourceKind;
  constructor(resource: ResourceKind, message: string) {
    super(message);
    this.name = "ResourceLimitError";
    this.resource = resource;
  }
}

export function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid ${label}`);
}
// #endregion contracts
