// #region contracts
import type { RunResult } from "../runtime/types.ts";

/** 事件摘要用于顺序核对，不冒充完整模型传输记录。 */
export type ObservedEvent = {
  runId: string;
  seq: number;
  type: string;
  outcomeStatus?: string;
};

/** 一次实际运行留下的证据；崩溃实验可能没有正常返回结果。 */
export type Evidence = {
  result: RunResult | null;
  trace: ObservedEvent[];
  facts: Record<string, unknown>;
};

/** 运行前写好的标准；actual 只读取证据，不负责执行任务。 */
export type Criterion = {
  name: string;
  actual: (evidence: Evidence) => unknown;
  expected: unknown;
};

/** 场景把运行条件和判定规则放在一起，二者分别执行。 */
export type EvaluationCase = {
  id: string;
  title: string;
  run: (directory: string) => Promise<Evidence>;
  criteria: Criterion[];
};

/** 一条规则的比较结果，保留差异供调试。 */
export type CheckResult = {
  name: string;
  passed: boolean;
  expected: unknown;
  actual?: unknown;
  error?: string;
};

/** 一个场景的最终结论；运行器异常也必须记为失败。 */
export type Verdict = {
  id: string;
  passed: boolean;
  checks: CheckResult[];
  error?: string;
};
// #endregion contracts
