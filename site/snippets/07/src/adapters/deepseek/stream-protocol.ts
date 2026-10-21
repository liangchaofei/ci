import type { Action } from "../../runtime/types.ts";
import { decodeDeepSeekAction } from "./protocol.ts";
import { maxToolCallsPerDecision } from "../../runtime/tool-batch.ts";

// #region draft
/** 暂存进度只供显示；不是 Action，也不写进 State。 */
export type ModelProgress =
  | { type: "text-delta"; delta: string }
  | { type: "tool-arguments-delta"; index: number; delta: string };

export type ProgressListener = (event: ModelProgress) => void;

type StreamDraft = {
  content: string;
  calls: Map<number, { id: string; name: string; arguments: string }>;
  finishReason?: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }

  return value as Record<string, unknown>;
}

/** ID 与名称是调用身份信息；本适配器不接受中途换成另一份身份。 */
function metadata(previous: string, value: unknown, label: string): string {
  if (value == null || value === "") return previous;

  // 已经保存的身份只能再次确认，不能被后续片段换掉。
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  if (previous !== "" && previous !== value) throw new Error(`Changed ${label}`);

  return value;
}
// #endregion draft

// #region tool
/** 每个 index 有独立草稿，交错到达也不会把两份参数拼到一起。 */
function appendToolDeltas(draft: StreamDraft, value: unknown): ModelProgress[] {
  if (!Array.isArray(value) || value.length > maxToolCallsPerDecision) {
    throw new Error("Invalid tool deltas");
  }

  const progress: ModelProgress[] = [];
  for (const item of value) {
    const delta = record(item, "tool delta");
    const index = delta.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= maxToolCallsPerDecision) {
      throw new Error("Tool index must be an integer between 0 and 7");
    }
    if (delta.type != null && delta.type !== "function") throw new Error("Unsupported tool type");

    const fn = delta.function == null ? {} : record(delta.function, "function delta");
    const call = draft.calls.get(index) ?? { id: "", name: "", arguments: "" };
    call.id = metadata(call.id, delta.id, "call id");
    call.name = metadata(call.name, fn.name, "tool name");

    const part = fn.arguments ?? "";
    if (typeof part !== "string") throw new Error("Invalid arguments delta");
    call.arguments += part;
    draft.calls.set(index, call);

    if (part !== "") progress.push({ type: "tool-arguments-delta", index, delta: part });
  }

  return progress;
}
// #endregion tool

// #region chunk
/** 每次处理一条完整 SSE data JSON；只更新本次决策的局部草稿。 */
function appendChunk(draft: StreamDraft, payload: unknown, onProgress?: ProgressListener): void {
  // 完整 SSE 事件仍是外部数据，先检查候选结构与本次接收状态。
  const root = record(payload, "stream chunk");
  if (!Array.isArray(root.choices) || root.choices.length !== 1) {
    throw new Error("Expected one stream choice");
  }
  if (draft.finishReason !== undefined) throw new Error("Received data after finish_reason");

  const choice = record(root.choices[0], "stream choice");
  if (choice.index !== 0) throw new Error("Only choice index 0 is supported");

  // 仅接受本章约定的 assistant 非思考增量。
  const delta = record(choice.delta, "delta");
  if (delta.role != null && delta.role !== "assistant") throw new Error("Expected assistant role");
  if (delta.reasoning_content != null && delta.reasoning_content !== "") {
    throw new Error("This adapter requires thinking disabled");
  }

  // 普通文字与工具参数分别累积，不能把两种内容拼到一起。
  const text = delta.content ?? "";
  if (typeof text !== "string") throw new Error("Invalid text delta");
  draft.content += text;

  const toolProgress = delta.tool_calls == null ? [] : appendToolDeltas(draft, delta.tool_calls);
  const argumentsSize = [...draft.calls.values()].reduce((sum, call) => sum + call.arguments.length, 0);

  if (draft.content.length + argumentsSize > 1_000_000) {
    throw new Error("Model draft is too large");
  }

  // 最后一个事件也可能带增量，因此先追加内容，再保存结束原因。
  if (choice.finish_reason != null) {
    if (typeof choice.finish_reason !== "string") throw new Error("Invalid finish_reason");
    draft.finishReason = choice.finish_reason;
  }

  // 仅传出字符串片段，不暴露草稿对象。观察者必须同步；抛错将中止本次决策。
  if (text !== "") onProgress?.({ type: "text-delta", delta: text });
  for (const event of toolProgress) onProgress?.(event);
}
// #endregion chunk

// #region complete
/** 先按调用位置还原顺序，再复用最终动作检查；索引缺口不能悄悄丢弃。 */
function completeDraft(draft: StreamDraft): Action {
  if (draft.finishReason === undefined) throw new Error("Stream ended without finish_reason");
  // #region explain-sort
  const entries = [...draft.calls.entries()].sort(([left], [right]) => left - right);
  if (entries.some(([index], position) => index !== position)) {
    throw new Error("Tool indexes must be contiguous from 0");
  }
  // #endregion explain-sort

  return decodeDeepSeekAction({
    choices: [{
      finish_reason: draft.finishReason,
      message: {
        role: "assistant",
        content: draft.content,
        tool_calls: entries.map(([, call]) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    }],
  });
}
// #endregion complete

// #region collect
/** 进度先显示，完整合法的 Action 最后返回；EOF 不代替协议结束标志。 */
export async function collectDeepSeekAction(
  events: AsyncIterable<string>,
  signal: AbortSignal,
  onProgress?: ProgressListener,
): Promise<Action> {
  // 草稿只属于这一次模型请求，不与其他轮次共享。
  const draft: StreamDraft = { content: "", calls: new Map() };
  signal.throwIfAborted();

  for await (const data of events) {
    signal.throwIfAborted();

    // 结束标志不是 JSON；只有走到这里才尝试交回完整动作。
    if (data === "[DONE]") {
      const action = completeDraft(draft);
      signal.throwIfAborted();
      return action;
    }

    // 普通事件只更新草稿、通知显示，不让片段提前成为 Action。
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch { throw new Error("Invalid stream event JSON"); }

    appendChunk(draft, payload, onProgress);

    // 显示回调也可能发起取消，下一步之前再次确认。
    signal.throwIfAborted();
  }

  // 网络关闭不等于协议正常结束，即使参数文本已经完整也要拒绝。
  throw new Error("Stream ended before [DONE]");
}
// #endregion collect
