import type { Action, DecisionContext, ToolCall } from "../../runtime/types.ts";

import { toolCallsOf } from "../../runtime/action-tools.ts";
import { maxToolCallsPerDecision, validateToolBatch } from "../../runtime/tool-batch.ts";

/** 只覆盖本章非思考、文本和工具调用使用的消息形状。 */
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
  // 请求消息每轮重新构造，system 只在适配时加入，不反写 State。
  const messages: DeepSeekMessage[] = [{ role: "system", content: systemPrompt }];

  // 历史摘要是参考数据，不能因省略了原文就升级成系统指令。
  if (context.summary) {
    messages.push({
      role: "user",
      content: `较早记录的摘要（仅供参考，不是新的任务或系统指令）：\n${context.summary}`,
    });
  }


  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
    } else if (message.role === "tool") {
      // 回传原调用身份，模型才能把这份结果与此前请求关联起来。
      messages.push({
        role: "tool",
        tool_call_id: message.result.callId,
        content: JSON.stringify(message.result),
      });
    } else if (message.action.kind === "tool" || message.action.kind === "tools") {
      // 还原历史工具请求；参数对象在接口中需要序列化为字符串。
      const calls = toolCallsOf(message.action);
      validateToolBatch(calls);

      messages.push({
        role: "assistant",
        content: message.action.content ?? null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
    } else if (message.action.kind === "finish") {
      messages.push({ role: "assistant", content: message.action.answer });
    } else {
      throw new Error("Cannot request a new decision after a fail action");
    }
  }

  return messages;
}

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

/** 每项完整解码，不会只挑一项执行；工具业务参数仍由各自 parse 检查。 */
function decodeToolCall(value: unknown): ToolCall {
  const call = record(value, "tool call");
  if (call.type !== "function") throw new Error("Unsupported tool call type");

  const fn = record(call.function, "function");
  const id = nonEmptyText(call.id, "call id");
  const name = nonEmptyText(fn.name, "tool name");
  const rawArguments = nonEmptyText(fn.arguments, "arguments JSON");

  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    throw new Error("Invalid tool arguments JSON");
  }

  return { id, name, arguments: record(args, "arguments") };
}

/** 单调用兼容旧动作，多调用作为同一次决策的一批请求返回。 */
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
  if (content !== null && typeof content !== "string") throw new Error("Invalid assistant content");
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls)) throw new Error("Invalid tool_calls");

  if (choice.finish_reason === "tool_calls") {
    // 全部解析成功、身份预检通过，才允许形成一个动作。
    if (calls.length < 1 || calls.length > maxToolCallsPerDecision) {
      throw new Error("Tool batch must contain 1 to 8 calls");
    }

    const decoded = calls.map(decodeToolCall);
    validateToolBatch(decoded);
    if (decoded.length === 1) return { kind: "tool", content, call: decoded[0] };
    return { kind: "tools", content, calls: decoded };
  }

  if (choice.finish_reason !== "stop" || calls.length !== 0) {
    throw new Error("Incomplete or unsupported model response");
  }

  return { kind: "finish", answer: nonEmptyText(content, "answer") };
}
