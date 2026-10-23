// #region probe
import { createModelBudget } from "../runtime/model-budget.ts";
import { ResourceLimitError } from "../runtime/resource-types.ts";

const budget = createModelBudget({ maxRequests: 2, maxConcurrent: 1, maxKnownTokens: 100, maxEstimatedCostUnits: 200 },
  { inputUnitsPerToken: 1, outputUnitsPerToken: 2 });
const first = budget.begin();
try { budget.begin(); }
catch (error) { if (error instanceof ResourceLimitError) console.log(`[启动被拒绝] ${error.resource}`); else throw error; }
first.report({ inputTokens: 40, outputTokens: 10 });
first.close();
first.close();
console.log(`[第一次快照] ${JSON.stringify(budget.snapshot())}`);
const second = budget.begin();
second.close();
console.log(`[缺少报告快照] ${JSON.stringify(budget.snapshot())}`);
// #endregion probe
