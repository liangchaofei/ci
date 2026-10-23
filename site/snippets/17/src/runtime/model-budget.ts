// #region contracts
import { createUsageLedger } from "./usage-ledger.ts";
import { ResourceLimitError, nonNegativeInteger } from "./resource-types.ts";
import type { ResourceLimits, UsageRates, TokenUsage, BudgetSnapshot } from "./resource-types.ts";

export type RequestLease = { report: (usage: TokenUsage) => void; close: () => void };
export type ModelBudget = { begin: () => RequestLease; snapshot: () => BudgetSnapshot };
// #endregion contracts

// #region budget
/** 一份逻辑任务共享一份；begin 必须紧邻实际 HTTP 尝试，而不是放在 decide 外。 */
export function createModelBudget(limits: ResourceLimits, rates: UsageRates): ModelBudget {
  const caps = { ...limits };
  nonNegativeInteger(caps.maxRequests, "maxRequests");
  if (!Number.isInteger(caps.maxConcurrent) || caps.maxConcurrent < 1 || caps.maxConcurrent > 8) {
    throw new RangeError("maxConcurrent must be between 1 and 8");
  }
  const ledger = createUsageLedger(caps, rates);
  let requests = 0;
  let active = 0;
  let peak = 0;
  let unreportedRequests = 0;

  function begin(): RequestLease {
// #region admission
    ledger.check(true);
    if (requests >= caps.maxRequests) throw new ResourceLimitError("model-requests", "Model request allowance reached");
    if (active >= caps.maxConcurrent) throw new ResourceLimitError("model-concurrency", "Model request slots are full");

// #endregion admission
    // 此段没有 await：先占名额再发请求，同一进程不能同时领走最后一个名额。
    requests += 1;
    active += 1;
    peak = Math.max(peak, active);
    let closed = false;
    let reported = false;

// #region lease
    return {
      report(usage) {
        if (closed || reported) throw new Error("Usage may be reported once for an open request");
        ledger.record(usage);
        reported = true;
        // 已发生的用量先记账，再检查超额；不能因超额而删除事实。
        ledger.check(false);
      },
      close() {
        if (closed) return;
        closed = true;
        active -= 1;
        if (!reported) unreportedRequests += 1;
      },
    };
// #endregion lease
  }

  return { begin, snapshot: () => ({ ...ledger.snapshot(), requests, active, peak, unreportedRequests }) };
}
// #endregion budget
