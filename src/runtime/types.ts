/** 执行器返回的事实。失败结果没有 content，避免误用失败数据。 */
export type Observation =
  | { kind: "read-ok"; path: string; content: string }
  | { kind: "read-failed"; path: string; reason: string };

/** 决策器提出的请求；finish 仍需由循环核验证据。 */
export type Action =
  | { kind: "read"; path: string }
  | { kind: "finish"; answer: string }
  | { kind: "fail"; reason: string };

/** 本章目标固定为读取指定路径，不接入真实磁盘。 */
export type Task = { targetPath: string };
/** 当前事实与已消费决策次数，属于单次运行。 */
export type State = Task & {
  // null 表示尚未执行，read-failed 表示已经执行但失败。
  observation: Observation | null;
  // 包含最后一次提出 finish 或 fail 的决策调用。
  decisions: number;
};

/** 记录运行过程，便于核对动作与观察的顺序。 */
export type Event =
  | { kind: "decision"; index: number; action: Action }
  | { kind: "observation"; observation: Observation };

/** 所有退出都有明确原因，耗尽预算不能算成功。 */
export type Outcome =
  | { status: "completed"; answer: string }
  | { status: "failed"; reason: string }
  | { status: "budget-exhausted" };

/** 将退出原因、最终事实和运行轨迹分别交付。 */
export type RunResult = {
  outcome: Outcome;
  state: State;
  events: Event[];
};

/** 外部能力由调用方注入，循环不创建模型或执行器。 */
export type Dependencies = {
  decide: (state: Readonly<State>) => Promise<Action>;
  executeRead: (
    action: Extract<Action, { kind: "read" }>,
  ) => Promise<Observation>;
};