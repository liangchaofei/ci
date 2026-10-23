import type { RunResult } from "../runtime/types.ts";

/** 事件摘要用于顺序核对，不冒充完整模型传输记录。 */
export type ObservedEvent = { runId: string; seq: number; type: string; outcomeStatus?: string };
export type Evidence = { result: RunResult | null; trace: ObservedEvent[]; facts: Record<string, unknown> };
export type Criterion = { name: string; actual: (evidence: Evidence) => unknown; expected: unknown };
export type EvaluationCase = {
  id: string;
  title: string;
  run: (directory: string) => Promise<Evidence>;
  criteria: Criterion[];
};
export type CheckResult = { name: string; passed: boolean; expected: unknown; actual?: unknown; error?: string };
export type Verdict = { id: string; passed: boolean; checks: CheckResult[]; error?: string };