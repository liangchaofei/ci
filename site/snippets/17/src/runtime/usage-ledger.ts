// #region ledger
import { ResourceLimitError, nonNegativeInteger } from "./resource-types.ts";
import type { ResourceLimits, TokenUsage, UsageRates, UsageTotals } from "./resource-types.ts";

/** 只累计已收到的用量，未知部分由请求门禁另记，绝不补成零费用。 */
export function createUsageLedger(limits: ResourceLimits, rates: UsageRates) {
  const caps = { ...limits };
  const prices = { ...rates };
  nonNegativeInteger(caps.maxKnownTokens, "maxKnownTokens");
  nonNegativeInteger(caps.maxEstimatedCostUnits, "maxEstimatedCostUnits");
  nonNegativeInteger(prices.inputUnitsPerToken, "input rate");
  nonNegativeInteger(prices.outputUnitsPerToken, "output rate");
  let totals: UsageTotals = { inputTokens: 0, outputTokens: 0, knownTokens: 0, estimatedCostUnits: 0 };

// #region check
  function check(beforeRequest: boolean): void {
    const reached = (used: number, cap: number) => beforeRequest ? used >= cap : used > cap;
    if (reached(totals.knownTokens, caps.maxKnownTokens)) {
      throw new ResourceLimitError("known-tokens", "Known token allowance reached");
    }
    if (reached(totals.estimatedCostUnits, caps.maxEstimatedCostUnits)) {
      throw new ResourceLimitError("estimated-cost", "Estimated cost allowance reached");
    }
  }

// #endregion check
// #region record
  function record(usage: TokenUsage): void {
    nonNegativeInteger(usage.inputTokens, "inputTokens");
    nonNegativeInteger(usage.outputTokens, "outputTokens");
    const inputTokens = totals.inputTokens + usage.inputTokens;
    const outputTokens = totals.outputTokens + usage.outputTokens;
    const next = { inputTokens, outputTokens, knownTokens: inputTokens + outputTokens,
      estimatedCostUnits: inputTokens * prices.inputUnitsPerToken + outputTokens * prices.outputUnitsPerToken };
    for (const [key, value] of Object.entries(next)) nonNegativeInteger(value, key);
    totals = next;
  }

// #endregion record
  return { record, check, snapshot: (): UsageTotals => ({ ...totals }) };
}
// #endregion ledger
