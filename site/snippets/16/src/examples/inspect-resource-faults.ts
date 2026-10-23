// #region faults
import { prepareBudgetScenario, normalLimits } from "./budget-scenario.ts";

for (const mode of ["requests", "tokens", "cost", "cancel", "time"] as const) {
  const limits = { ...normalLimits };
  if (mode === "requests") limits.maxRequests = 2;
  if (mode === "tokens") limits.maxKnownTokens = 49;
  if (mode === "cost") limits.maxEstimatedCostUnits = 59;
  const { agent, budget } = await prepareBudgetScenario(limits, mode === "time" ? 1 : 10_000);
  agent.subscribe((event) => {
    if (mode === "cancel" && event.type === "decision-started") agent.cancel();
    if (event.type === "run-ended") console.log(`[${mode} 结束报告] ${event.outcome.status}`);
  });
  const result = await agent.run("诊断演示副本，不修改文件。");
  console.log(`[${mode}] ${JSON.stringify(result.outcome)}，已记录决策=${result.state.decisions}`);
  console.log(`[${mode} 账本] ${JSON.stringify(budget.snapshot())}`);
}
// #endregion faults
