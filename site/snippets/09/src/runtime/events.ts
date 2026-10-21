// #region contracts
import { randomUUID } from "node:crypto";
import type { Action, Outcome } from "./types.ts";

/** 报告阶段信息与最终 Outcome；不传出完整历史或可变 State 引用。 */
export type EventPayload =
  | { type: "run-started" }
  | {
      type: "decision-started";
      decision: number;
      inputMessages: number;
      inputBytes: number;
      hasSummary: boolean;
    }
  | { type: "decision-recorded"; decision: number; kind: Action["kind"]; callIds: string[] }
  | { type: "batch-started"; callIds: string[] }
  | { type: "results-recorded"; callIds: string[]; statuses: ("ok" | "error")[] }
  | { type: "run-ended"; outcome: Outcome; decisions: number; messages: number }
  | { type: "run-crashed"; reason: string };

/** runId 区分运行；seq 只在同一次运行内从 1 递增。 */
export type RunEvent = EventPayload & { runId: string; seq: number };
export type EventListener = (event: RunEvent) => void | Promise<void>;
// #endregion contracts

// #region bus
/** 每位观察者得到独立副本；观察失败不改变任务结果。 */
export function createEventBus() {
  const listeners = new Set<EventListener>();

  // #region explain-subscribe
  function subscribe(listener: EventListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  // #endregion explain-subscribe

  function emit(event: RunEvent): void {
    // 固定本次接收名单；订阅变动从下一次 emit 开始生效。
    for (const listener of [...listeners]) {
      // #region explain-delivery
      try {
        const pending = listener(structuredClone(event));
        // 不等待异步观察者，但仍接住它稍后产生的拒绝。
        void Promise.resolve(pending).catch(() => {});
      } catch {
        // 这是通知通道；权限检查和完成验证不能写在观察者中。
      }
      // #endregion explain-delivery
    }
  }

  return { subscribe, emit };
}
// #endregion bus

// #region reporter
/** 一次循环一份报告器，负责运行身份和顺序编号。 */
export function createRunReporter(listener?: EventListener) {
  const runId = randomUUID();
  const bus = createEventBus();
  let seq = 0;

  if (listener) bus.subscribe(listener);

  return (payload: EventPayload): void => {
    seq += 1;
    bus.emit({ ...payload, runId, seq });
  };
}
// #endregion reporter
