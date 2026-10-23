// #region run
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { normalCase } from "../evaluation/cases/normal.ts";
import { grade } from "../evaluation/grader.ts";

await mkdir(".agent-data", { recursive: true });
const directory = await mkdtemp(resolve(".agent-data/evaluation-normal-"));
// 本命令只有一个场景；副本函数此后创建的文件也归入这个独立目录。
process.chdir(directory);

// 先得到真实运行证据，再独立比较；判定不会改写 Agent 的结果。
const evidence = await normalCase.run(directory);
const verdict = grade(normalCase, evidence);

// 分开保存“发生了什么”和“哪些规则满足”，便于定位差异。
await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
await writeFile(join(directory, "verdict.json"), JSON.stringify(verdict, null, 2));

for (const check of verdict.checks)
  console.log(`[${check.passed ? "通过" : "失败"}] ${check.name}`);
console.log(`[证据目录] ${directory}`);

// 非零退出码让终端或自动检查知道本项不符合期望。
if (!verdict.passed) process.exitCode = 1;
// #endregion run
