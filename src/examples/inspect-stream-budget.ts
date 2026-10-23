import { createModelBudget } from "../runtime/model-budget.ts";
import { ResourceLimitError } from "../runtime/resource-types.ts";
import { requestDeepSeekEvents } from "../adapters/deepseek/stream-http.ts";
import { collectDeepSeekAction } from "../adapters/deepseek/stream-protocol.ts";

/** 完整离线 SSE：用量随最后一个内容事件返回，再发送结束标志。 */
function response(): Response {
  const last = { choices: [{ index: 0, delta: { content: "离线演示答案" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } };
  const text = `data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

for (const cap of [200, 49]) {
  const budget = createModelBudget({ maxRequests: 1, maxConcurrent: 1, maxKnownTokens: cap, maxEstimatedCostUnits: 200 },
    { inputUnitsPerToken: 1, outputUnitsPerToken: 2 });
  const signal = new AbortController().signal;
  try {
    const events = requestDeepSeekEvents("offline-placeholder", {}, signal, { budget, fetch: async () => response() });
    const action = await collectDeepSeekAction(events, signal);
    console.log(`[流式上限 ${cap}] 动作=${action.kind}`);
  } catch (error) {
    if (!(error instanceof ResourceLimitError)) throw error;
    console.log(`[流式上限 ${cap}] 动作未交付，原因=${error.resource}`);
  }
  console.log(`[流式账本] ${JSON.stringify(budget.snapshot())}`);
}