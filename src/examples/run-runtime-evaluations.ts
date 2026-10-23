import { runtimeCases } from "../evaluation/cases/index.ts";
import { runEvaluations } from "../evaluation/runner.ts";

const selectedId = process.argv[2];
const selected = selectedId === undefined ? runtimeCases : runtimeCases.filter((c) => c.id === selectedId);
if (selected.length === 0) throw new Error(`Unknown case: ${selectedId}`);
const { directory, report } = await runEvaluations(selected);
console.log(`[评估结果] ${report.passed ? "全部通过" : "存在失败"}`);
console.log(`[证据目录] ${directory}`);
if (!report.passed) process.exitCode = 1;