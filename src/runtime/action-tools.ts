import type { Action, Message, ToolCall } from "./types.ts";

/** 兼容已有单调用；只读取动作，不复制、校验或执行。 */
export function toolCallsOf(action: Action): readonly ToolCall[] {
  if (action.kind === "tool") return [action.call];
  if (action.kind === "tools") return action.calls;
  return [];
}

/** 从已有记录取出用过的身份，供新动作预检。 */
export function previousToolCallIds(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? toolCallsOf(message.action).map((call) => call.id) : [],
  );
}