/** 模型提出的工具请求；id 标识一次调用，name 标识工具种类。 */
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};


/** 工具执行后得到的事实；失败不能伪装成成功值。 */
export type ToolResult =
  | { callId: string; status: "ok"; value: unknown }
  | { callId: string; status: "error"; message: string };


/** 模型提出的请求。finish 仍要经过应用的完成验证。 */
export type Action =
  | { kind: "tool"; call: ToolCall }
  | { kind: "finish"; answer: string }
  | { kind: "fail"; reason: string };

/** 本章的最小会话记录，按发生顺序追加。 */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; action: Action }
  | { role: "tool"; result: ToolResult };

/** 一次运行的当前事实；不同运行不能共享这个对象。 */
export type State = {
  goal: string;
  messages: Message[];
  decisions: number;
};

/** Runtime 的退出原因，与会话里保留的事实分别表达。 */
export type Outcome =
  | { status: "completed"; answer: string }
  | {
      status: "failed";
      reason: string;
      source: "decision" | "execution" | "validation";
    }
  | { status: "budget-exhausted" };

export type RunResult = { state: State; outcome: Outcome };

/** 由调用方提供模型、工具和任务完成规则，循环只负责调度。 */
export type Dependencies = {
  // 接收当前状态的副本，提出下一步；本章由脚本函数扮演模型。
  decide: (state: Readonly<State>) => Promise<Action>;
  // 取得一次请求的实际结果，必须回传同一个调用 ID。
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  // 核对当前场景的完成证据，不把模型的 finish 直接当成成功。
  validateFinish: (state: Readonly<State>, answer: string) => boolean;
};