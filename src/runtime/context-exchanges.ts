import type { Message } from "./types.ts";
import { toolCallsOf } from "./action-tools.ts";
import { validateToolBatch } from "./tool-batch.ts";

/** 一次请求动作和它的全部结果组成一组，裁剪时不能拆开。 */
export function groupExchanges(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") throw new Error("Tool result has no preceding request");

    const calls = message.role === "assistant" ? toolCallsOf(message.action) : [];
    if (calls.length === 0) {
      if (message.role === "assistant" && message.action.kind === "tools") {
        throw new Error("Empty tool batch in history");
      }
      groups.push([message]);
      continue;
    }

    validateToolBatch(calls, usedIds);
    const pending = new Set(calls.map((call) => call.id));
    for (const id of pending) usedIds.add(id);
    const group: Message[] = [message];

    // 请求后必须有每一项的对应结果；不完整的批次不能作为合法输入裁剪。
    for (let count = 0; count < calls.length; count += 1) {
      index += 1;
      const observation = messages[index];
      if (!observation || observation.role !== "tool" || !pending.delete(observation.result.callId)) {
        throw new Error("Incomplete or mismatched tool exchange");
      }
      group.push(observation);
    }

    groups.push(group);
  }

  return groups;
}