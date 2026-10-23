import type { Action } from "../../runtime/types.ts";
import { decodeDeepSeekAction } from "./protocol.ts";

// #region draft
/** 暂存进度只供显示；不是 Action，也不写进 State。 */
export type ModelProgress =
  | { type: "text-delta"; delta: string }
  | { type: "tool-arguments-delta"; delta: string };

export type ProgressListener = (event: ModelProgress) => void;

type StreamDraft = {
  content: string;
  call?: { id: string; name: string; arguments: string };
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
/** 只拼接第 0 个调用的参数文本；此处从不尝试执行或解析半份参数。 */
function appendToolDelta(draft: StreamDraft, value: unknown): string {
  // 先确认本片只有一个调用；空数组表示这次没有新增工具内容。
  if (!Array.isArray(value)) throw new Error("Invalid tool deltas");
  if (value.length === 0) return "";
  if (value.length !== 1) throw new Error("Expected one tool delta");

  // 当前只支持第 0 个函数调用，不能把其他调用的片段混进来。
  const delta = record(value[0], "tool delta");
  if (delta.index !== 0) throw new Error("Only tool index 0 is supported");
  if (delta.type != null && delta.type !== "function") throw new Error("Unsupported tool type");

  // 首片创建调用草稿，后续片段复用它，保留之前的身份与参数。
  // #region explain-draft
  const fn = delta.function == null ? {} : record(delta.function, "function delta");
  const call = draft.call ?? { id: "", name: "", arguments: "" };
  call.id = metadata(call.id, delta.id, "call id");
  call.name = metadata(call.name, fn.name, "tool name");

  // 参数仍是文本：先确认本片类型，不在这里解析半份 JSON。
  const part = fn.arguments ?? "";
  if (typeof part !== "string") throw new Error("Invalid arguments delta");

  // 只追加到本次决策的草稿，不写 State，也不执行工具。
  call.arguments += part;
  draft.call = call;
  // #endregion explain-draft

  // 交回本次新增文本，供上层显示进度，而不是交回全部参数。
  return part;
}
// #endregion tool

// #region chunk
/** 一个完整 SSE data JSON 对应一次调用；只更新本次决策的局部草稿。 */
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

  let argumentsPart = "";
  if (delta.tool_calls != null) argumentsPart = appendToolDelta(draft, delta.tool_calls);

  if (draft.content.length + (draft.call?.arguments.length ?? 0) > 1_000_000) {
    throw new Error("Model draft is too large");
  }

  // 最后一个事件也可能带增量，因此先追加内容，再保存结束原因。
  if (choice.finish_reason != null) {
    if (typeof choice.finish_reason !== "string") throw new Error("Invalid finish_reason");
    draft.finishReason = choice.finish_reason;
  }

  // 仅传出字符串片段，不暴露草稿对象。观察者必须同步；抛错将中止本次决策。
  if (text !== "") onProgress?.({ type: "text-delta", delta: text });
  if (argumentsPart !== "") onProgress?.({ type: "tool-arguments-delta", delta: argumentsPart });
}
// #endregion chunk

// #region complete
/** 只在收到 [DONE] 后调用，并复用第 6 篇的最终响应检查。 */
function completeDraft(draft: StreamDraft): Action {
  if (draft.finishReason === undefined) throw new Error("Stream ended without finish_reason");

  // 恢复为原解码器认识的完整响应形状，复用同一套最终检查。
  return decodeDeepSeekAction({
    choices: [{
      finish_reason: draft.finishReason,
      message: {
        role: "assistant",
        content: draft.content,
        tool_calls: draft.call ? [{
          id: draft.call.id,
          type: "function",
          function: { name: draft.call.name, arguments: draft.call.arguments },
        }] : [],
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
  const draft: StreamDraft = { content: "" };
  signal.throwIfAborted();

  for await (const data of events) {
    signal.throwIfAborted();

    // 结束标志不是 JSON；只有走到这里才尝试交回完整动作。
    // #region explain-done
    if (data === "[DONE]") {
      const action = completeDraft(draft);
      signal.throwIfAborted();
      return action;
    }
    // #endregion explain-done

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
