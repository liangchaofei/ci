import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNode, ChildRunError } from "./process.ts";
import { readEvidence } from "./evidence.ts";
import { grade } from "./grader.ts";
import type { EvaluationCase, Verdict } from "./contracts.ts";

/** 一项场景一个子进程、一个目录；故障不靠共享可变状态串到下一项。 */
export async function runEvaluations(cases: readonly EvaluationCase[]) {
  if (cases.length === 0 || new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error("Expected non-empty unique case list");
  await mkdir(".agent-data", { recursive: true });
  const directory = await mkdtemp(resolve(".agent-data/evaluations-"));
  const worker = fileURLToPath(new URL("./case-worker.ts", import.meta.url));
  const verdicts: Verdict[] = [];

  for (const definition of cases) {
    if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) throw new Error("Invalid case ID");
    const caseDirectory = join(directory, definition.id);
    await mkdir(caseDirectory);
    let verdict: Verdict;
    try {
      const child = await runNode(worker, [definition.id, caseDirectory], caseDirectory);
      await writeFile(join(caseDirectory, "stdout.log"), child.stdout);
      await writeFile(join(caseDirectory, "stderr.log"), child.stderr);
      const evidence = readEvidence(JSON.parse(await readFile(join(caseDirectory, "evidence.json"), "utf8")));
      verdict = grade(definition, evidence);
    } catch (error) {
      if (error instanceof ChildRunError) {
        await writeFile(join(caseDirectory, "stdout.log"), error.stdout);
        await writeFile(join(caseDirectory, "stderr.log"), error.stderr);
      }
      verdict = { id: definition.id, passed: false, checks: [], error: error instanceof Error ? error.message : String(error) };
    }
    await writeFile(join(caseDirectory, "verdict.json"), JSON.stringify(verdict, null, 2));
    verdicts.push(verdict);
    console.log(`[${verdict.passed ? "通过" : "失败"}] ${definition.id}：${definition.title}`);
  }

  const report = { passed: verdicts.every((v) => v.passed), cases: verdicts };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  return { directory, report };
}