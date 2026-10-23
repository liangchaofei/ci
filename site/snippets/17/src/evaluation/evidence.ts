// #region imports
import type { Agent } from "../runtime/agent.ts";
import { parseSessionRecord } from "../runtime/session-codec.ts";
import type { Criterion, Evidence, ObservedEvent } from "./contracts.ts";
// #endregion imports

// #region observe
/** 订阅真实实例事件，只保留本章需要核对的摘要。 */
export function observe(agent: Agent): ObservedEvent[] {
  const trace: ObservedEvent[] = [];

  // 订阅只收集观察，不参与循环，也不向 State 追加消息。
  agent.subscribe((event) => {
    trace.push({
      runId: event.runId,
      seq: event.seq,
      type: event.type,
      ...(event.type === "run-ended" ? { outcomeStatus: event.outcome.status } : {}),
    });
  });

  return trace;
}

/** 这些规则用于正常返回的运行；崩溃实验使用自己的磁盘证据。 */
export function runCriteria(): Criterion[] {
  return [
    {
      name: "事件序号从 1 连续",
      actual: (e) => e.trace.length > 0 && e.trace.every((t, i) => t.seq === i + 1),
      expected: true,
    },
    {
      name: "摘要只含一个运行身份",
      actual: (e) => new Set(e.trace.map((t) => t.runId)).size,
      expected: 1,
    },
    {
      name: "只报告一次正常协议结束",
      actual: (e) => e.trace.filter((t) => t.type === "run-ended").length,
      expected: 1,
    },
    {
      name: "最后报告与结果一致",
      actual: (e) =>
        e.result !== null &&
        e.trace.at(-1)?.type === "run-ended" &&
        e.trace.at(-1)?.outcomeStatus === e.result.outcome.status,
      expected: true,
    },
  ];
}
// #endregion observe

// #region decode
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected evidence object");
  return value as Record<string, unknown>;
}

/** 从子进程读到的是 JSON，须核对形状后再交给判定器。 */
export function readEvidence(value: unknown): Evidence {
  const data = object(value);

  // 借用已有解析器验证 RunResult；这个临时外壳不会保存为会话。
  const result =
    data.result === null
      ? null
      : parseSessionRecord({
          version: 1,
          sessionId: "evaluation",
          runId: "decode-only",
          seq: 1,
          result: data.result,
        }).result;

  // 子进程写出的 JSON 不能直接当成 TypeScript 类型使用。
  if (!Array.isArray(data.trace)) throw new Error("Expected trace array");

  const trace = data.trace.map((value): ObservedEvent => {
    const t = object(value);
    if (
      typeof t.runId !== "string" ||
      !t.runId ||
      !Number.isSafeInteger(t.seq) ||
      Number(t.seq) < 1 ||
      typeof t.type !== "string" ||
      (t.outcomeStatus !== undefined && typeof t.outcomeStatus !== "string")
    ) {
      throw new Error("Invalid observed event");
    }

    return {
      runId: t.runId,
      seq: Number(t.seq),
      type: t.type,
      ...(typeof t.outcomeStatus === "string"
        ? { outcomeStatus: t.outcomeStatus }
        : {}),
    };
  });

  // facts 的具体字段由各场景检查；缺字段不能默认当作成功。
  return {
    result,
    trace,
    facts: object(data.facts),
  };
}
// #endregion decode
