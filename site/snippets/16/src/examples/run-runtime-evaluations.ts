// #region run
import { runtimeCases } from "../evaluation/cases/index.ts";
import { runEvaluations } from "../evaluation/runner.ts";

// 不传 ID 就跑全部；传入 ID 只能选择已有场景。
const selectedId = process.argv[2];
const selected =
  selectedId === undefined
    ? runtimeCases
    : runtimeCases.filter((c) => c.id === selectedId);
if (selected.length === 0) throw new Error(`Unknown case: ${selectedId}`);

// 等所有场景判定结束，再打印总结果和本次证据位置。
const { directory, report } = await runEvaluations(selected);
console.log(`[评估结果] ${report.passed ? "全部通过" : "存在失败"}`);
console.log(`[证据目录] ${directory}`);

// 任务预期失败不一定导致这里失败；这里读取的是场景判定。
if (!report.passed) process.exitCode = 1;
// #endregion run
