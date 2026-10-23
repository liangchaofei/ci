// #region imports
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseIntegrationMode, runIntegratedScenario } from "./integrated-scenario.ts";
// #endregion imports

// #region run
const mode = parseIntegrationMode(process.argv[2] ?? "normal");
const supplied = process.argv[3];
if (mode === "resume" && !supplied)
  throw new Error("Resume requires the directory printed by pause");

await mkdir(".agent-data", { recursive: true });
// 新任务创建独立目录；接续时才使用上一次明确给出的目录。
const base = supplied
  ? resolve(supplied)
  : await mkdtemp(resolve(".agent-data/integration-"));
const report = await runIntegratedScenario(base, mode);

// 保存可核对数据；wx 防止误覆盖上次同模式运行的报告。
const reportPath = join(base, `${mode}-report.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });

for (const event of report.trace) {
  console.log(`[运行事件] ${event.seq} ${event.type}`);
}
console.log(`[任务结果 outcome] ${report.result.outcome.status}`);
console.log(`[已记录决策 decisions] ${report.result.state.decisions}`);
console.log(
  `[模型传输 requests] ${report.budget.requests}，服务实际调用=${report.httpCalls}`,
);
console.log(
  `[已报告 token] ${report.budget.knownTokens}，未报告请求=${report.budget.unreportedRequests}`,
);
console.log(`[实验目录] ${base}`);
console.log(`[完整报告] ${reportPath}`);
// #endregion run
