import { toolCallsOf, previousToolCallIds } from "../../runtime/action-tools.ts";
import { validateToolBatch } from "../../runtime/tool-batch.ts";
import type { Action, Dependencies } from "../../runtime/types.ts";
import type { ToolRegistry } from "../../runtime/tool-registry.ts";
import { requestDeepSeek } from "./http.ts";
import { requestDeepSeekEvents } from "./stream-http.ts";
import { collectDeepSeekAction } from "./stream-protocol.ts";
import type { ProgressListener } from "./stream-protocol.ts";
import { buildDeepSeekMessages, decodeDeepSeekAction } from "./protocol.ts";

// #region options
export type DeepSeekOptions = {
  apiKey: string;
  model: string;
  systemPrompt: string;
  registry: ToolRegistry;
  stream?: boolean;
  onProgress?: ProgressListener;
};
// #endregion options

// #region factory
/** 提供原 Dependencies.decide 接口；不自行运行工具或追加消息。 */
export function createDeepSeekDecider(options: DeepSeekOptions): Dependencies["decide"] {
  const { apiKey, model, systemPrompt, registry } = options;
  if (!apiKey.trim() || !model.trim()) throw new Error("API key and model are required");

  // 创建阶段只准备工具说明；真正的网络请求在返回函数中才开始。
  const tools = registry.names().map((name) => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Missing registered tool: ${name}`);

    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  });

  return async (context, signal) => {
    // 每轮从最新 Context 构造请求，才能带上前一轮刚得到的工具结果。
    const messages = buildDeepSeekMessages(context, systemPrompt);
    console.log(`[请求模型 model] 消息角色（roles）=${messages.map((m) => m.role).join(" -> ")}`);

    const body = {
      model, messages, tools, tool_choice: "auto",
      thinking: { type: "disabled" }, max_tokens: 1024,
    };

    // 两种传输方式最后都只交回一个完整 Action，循环接口保持一致。
    let action: Action;
    if (options.stream) {
      const events = requestDeepSeekEvents(apiKey, body, signal);
      action = await collectDeepSeekAction(events, signal, options.onProgress);
    } else {
      const payload = await requestDeepSeek(apiKey, { ...body, stream: false }, signal);
      action = decodeDeepSeekAction(payload);
    }

    // 单次与批次调用共用历史身份检查；模型不能复用先前的 ID。
    const calls = toolCallsOf(action);
    if (calls.length > 0) validateToolBatch(calls, previousToolCallIds(context.messages));

    console.log(`[模型动作 action] ${action.kind}`);
    return action;
  };
}
// #endregion factory
