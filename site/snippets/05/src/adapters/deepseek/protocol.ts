import type { Action, DecisionContext } from "../../runtime/types.ts";

// #region messages
/** 只覆盖本章非思考、文本和单工具调用使用的消息形状。 */
export type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** 每轮从最新 Context 构造请求，不维护第二份隐藏会话。 */
export function buildDeepSeekMessages(
  context: DecisionContext,
  systemPrompt: string,
): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
    } else if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.result.callId,
        content: JSON.stringify(message.result),
      });
    } else if (message.action.kind === "tool") {
      const { call, content } = message.action;
      messages.push({
        role: "assistant",
        content: content ?? null,
        tool_calls: [{
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }],
      });
    } else if (message.action.kind === "finish") {
      messages.push({ role: "assistant", content: message.action.answer });
    } else {
      throw new Error("Cannot request a new decision after a fail action");
    }
  }
  return messages;
}
// #endregion messages

// #region helpers
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: expected object`);
  return value;
}
function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  return value;
}
// #endregion helpers

// #region decode
/** 不完整、错误形状和多调用都拒绝，不能挑一项悄悄执行。 */
export function decodeDeepSeekAction(payload: unknown): Action {
  const root = record(payload, "response");
  if (!Array.isArray(root.choices) || root.choices.length !== 1) {
    throw new Error("Expected exactly one model choice");
  }
  const choice = record(root.choices[0], "choice");
  const message = record(choice.message, "assistant message");
  if (message.role !== "assistant") throw new Error("Expected assistant role");
  if (message.reasoning_content != null && message.reasoning_content !== "") {
    throw new Error("This adapter requires thinking disabled");
  }
  const content = message.content;
  if (content !== null && typeof content !== "string") {
    throw new Error("Invalid assistant content");
  }
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls)) throw new Error("Invalid tool_calls");

  if (choice.finish_reason === "tool_calls") {
    if (calls.length !== 1) throw new Error("This runtime supports one tool call per decision");
    const call = record(calls[0], "tool call");
    if (call.type !== "function") throw new Error("Unsupported tool call type");
    const fn = record(call.function, "function");
    const id = nonEmptyText(call.id, "call id");
    const name = nonEmptyText(fn.name, "tool name");
    const rawArguments = nonEmptyText(fn.arguments, "arguments JSON");
    let args: unknown;
    try { args = JSON.parse(rawArguments); }
    catch { throw new Error("Invalid tool arguments JSON"); }
    return { kind: "tool", content, call: { id, name, arguments: record(args, "arguments") } };
  }
  if (choice.finish_reason !== "stop" || calls.length !== 0) {
    throw new Error("Incomplete or unsupported model response");
  }
  return { kind: "finish", answer: nonEmptyText(content, "answer") };
}
// #endregion decode
