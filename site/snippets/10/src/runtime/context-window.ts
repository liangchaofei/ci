import type { DecisionContext, Message } from "./types.ts";
import { groupExchanges } from "./context-exchanges.ts";

/** 限制本项目 Context 的 JSON 字节数；不是服务端 token 计量。 */
export type ContextWindowOptions = {
  maxBytes: number;
  keepRecentExchanges?: number;
  summarize?: (omitted: readonly Message[]) => string;
};

/** 只表示输入选择仍装不下，不依赖错误文字识别。 */
export class ContextWindowError extends Error {}

export function measureContextBytes(context: DecisionContext): number {
  return new TextEncoder().encode(JSON.stringify(context)).byteLength;
}

/** 创建输入选择器；不删除 State，不修改工具返回值，也不调用模型。 */
export function createContextWindow(options: ContextWindowOptions): (messages: readonly Message[]) => DecisionContext {
  const { maxBytes, summarize } = options;
  const keepRecent = options.keepRecentExchanges ?? 1;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 1) {
    throw new RangeError("keepRecentExchanges must be a positive safe integer");
  }

  return (messages) => {
    // 后续选择和摘要只接触副本，不把运行历史的可变引用交给外部。
    const copy = structuredClone(messages);
    const first = copy[0];
    if (!first || first.role !== "user") throw new Error("Context must start with the original user request");

    const groups = groupExchanges(copy.slice(1));
    const maxDrop = Math.max(0, groups.length - keepRecent);

    // 先试全量；每次只多省略最早的一整组，优先保留更多近期原文。
    for (let drop = 0; drop <= maxDrop; drop += 1) {
      // 新追加的 user 也要保留；旧输入不能被预算悄悄省略。
      // #region selection
      const retained = groups.filter((group, index) => index >= drop || group[0].role === "user").flat();
      const omitted = groups.slice(0, drop).filter((group) => group[0].role !== "user").flat();

      let summary: string | undefined;
      if (omitted.length > 0 && summarize) {
        const text = summarize(structuredClone(omitted));
        if (typeof text !== "string") throw new Error("Context summary must be text");
        if (text.trim()) summary = text;
      }

      const context: DecisionContext = {
        messages: [first, ...retained],
        ...(summary ? { summary } : {}),
      };

      // 摘要也占输入空间，不能先按消息算好预算，再无限追加摘要。
      if (measureContextBytes(context) <= maxBytes) return context;
      // #endregion selection
    }

    throw new ContextWindowError("Original request, recent exchanges and summary exceed maxBytes");
  };
}
