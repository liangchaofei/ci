import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { normalCase } from "../evaluation/cases/normal.ts";
import { grade } from "../evaluation/grader.ts";

await mkdir(".agent-data", { recursive: true });
const directory = await mkdtemp(resolve(".agent-data/evaluation-normal-"));
// 本命令只有一个场景；副本函数此后创建的文件也归入这个独立目录。
process.chdir(directory);
const evidence = await normalCase.run(directory);
const verdict = grade(normalCase, evidence);
await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
await writeFile(join(directory, "verdict.json"), JSON.stringify(verdict, null, 2));
for (const check of verdict.checks) console.log(`[${check.passed ? "通过" : "失败"}] ${check.name}`);
console.log(`[证据目录] ${directory}`);
if (!verdict.passed) process.exitCode = 1;