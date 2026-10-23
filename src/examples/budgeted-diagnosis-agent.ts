import { prepareBudgetScenario } from "./budget-scenario.ts";

const { agent, budget } = await prepareBudgetScenario();
agent.subscribe((event) => {
  if (event.type === "run-ended") console.log(`[结束报告] ${event.outcome.status}`);
});
const result = await agent.run("诊断演示副本的空数组求和问题，不修改文件。");
console.log(`[结束详情] ${JSON.stringify(result.outcome)}`);
console.log(`[决策次数] ${result.state.decisions}`);
console.log(`[资源账本] ${JSON.stringify(budget.snapshot())}`);