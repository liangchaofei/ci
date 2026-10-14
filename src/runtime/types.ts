/** 本章工具值限制为可复制的 JSON 数据，不携带资源句柄。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** id 关联一次请求与结果；arguments 必须先校验，不能相信类型断言。 */
export type ToolCall = { id: string; name: string; arguments: unknown };
export type ToolResult =
  | { callId: string; toolName: string; status: "ok"; value: JsonValue }
  | { callId: string; toolName: string; status: "error";
      code: "unknown-tool" | "invalid-arguments" | "execution-failed"; message: string };

export type Action =
  | { kind: "tool"; call: ToolCall }
  | { kind: "finish"; answer: string }
  | { kind: "fail"; reason: string };
export type Task = { goal: string };
export type State = Task & { observations: ToolResult[]; decisions: number };
export type Event =
  | { kind: "decision"; index: number; action: Action }
  | { kind: "observation"; observation: ToolResult };
export type Outcome =
  | { status: "completed"; answer: string }
  | { status: "failed"; reason: string; source?: "decision" | "execution" | "validation" }
  | { status: "budget-exhausted" }
  | { status: "cancelled" }
  | { status: "timed-out" };
export type RunResult = { outcome: Outcome; state: State; events: Event[] };
export type RunOptions = { timeoutMs?: number; signal?: AbortSignal };

/** 应用提供任务规则，循环只驱动机制。 */
export type Dependencies = {
  decide: (state: Readonly<State>, signal: AbortSignal) => Promise<Action>;
  executeToolCall: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
  validateFinish: (state: Readonly<State>, answer: string) => boolean;
};

/** parse 将不可信参数变成已检查的输入，execute 才接收该类型。 */
export type ToolDefinition<Input, Output extends JsonValue> = {
  name: string;
  description: string;
  parse: (input: unknown) => Input;
  execute: (input: Input, signal: AbortSignal) => Promise<Output>;
};
