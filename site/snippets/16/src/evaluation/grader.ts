// #region grader
import { isDeepStrictEqual } from "node:util";
import type { EvaluationCase, Evidence, Verdict } from "./contracts.ts";

/** 判定标准在运行前定义；一个条件失败或抛错都不能算通过。 */
export function grade(definition: EvaluationCase, evidence: Evidence): Verdict {
  if (definition.criteria.length === 0)
    throw new Error("Evaluation must have criteria");

  // 每条规则独立提取；一条提取器改动副本，不会污染后续规则。
  const checks = definition.criteria.map((criterion) => {
    try {
      // #region compare
      const actual = criterion.actual(structuredClone(evidence));

      // <missing> 只用于报告显示，比较时仍使用原始 actual。
      return {
        name: criterion.name,
        expected: criterion.expected,
        actual: actual === undefined ? "<missing>" : actual,
        passed: isDeepStrictEqual(actual, criterion.expected),
      };
      // #endregion compare
    } catch (error) {
      // 规则取错字段或解析失败也算失败，并保留原因。
      return {
        name: criterion.name,
        expected: criterion.expected,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // 不能用“多数通过”掩盖某项边界失守。
  return {
    id: definition.id,
    passed: checks.every((check) => check.passed),
    checks,
  };
}
// #endregion grader
