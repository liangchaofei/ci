import { isDeepStrictEqual } from "node:util";
import type { EvaluationCase, Evidence, Verdict } from "./contracts.ts";

/** 判定标准在运行前定义；一个条件失败或抛错都不能算通过。 */
export function grade(definition: EvaluationCase, evidence: Evidence): Verdict {
  if (definition.criteria.length === 0) throw new Error("Evaluation must have criteria");
  const checks = definition.criteria.map((criterion) => {
    try {
      const actual = criterion.actual(structuredClone(evidence));
      return { name: criterion.name, expected: criterion.expected,
        actual: actual === undefined ? "<missing>" : actual,
        passed: isDeepStrictEqual(actual, criterion.expected) };
    } catch (error) {
      return { name: criterion.name, expected: criterion.expected, passed: false,
        error: error instanceof Error ? error.message : String(error) };
    }
  });
  return { id: definition.id, passed: checks.every((check) => check.passed), checks };
}