import type { Dependencies } from "../../runtime/types.ts";
import type { ToolRegistry } from "../../runtime/tool-registry.ts";
import { requestDeepSeek } from "./http.ts";
import { buildDeepSeekMessages, decodeDeepSeekAction } from "./protocol.ts";


export type DeepSeekOptions = {
  apiKey: string;
  model: string;
  systemPrompt: string;
  registry: ToolRegistry;
};


/** 提供原 Dependencies.decide 接口；不自行运行工具或追加消息。 */
export function createDeepSeekDecider(options: DeepSeekOptions): Dependencies["decide"] {
  const { apiKey, model, systemPrompt, registry } = options;
  if (!apiKey.trim() || !model.trim()) throw new Error("API key and model are required");
  const tools = registry.names().map((name) => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Missing registered tool: ${name}`);
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  });
  return async (context, signal) => {
    const messages = buildDeepSeekMessages(context, systemPrompt);
    console.log(`[请求模型 model] 消息角色（roles）=${messages.map((m) => m.role).join(" -> ")}`);
    const payload = await requestDeepSeek(apiKey, {
      model, messages, tools, tool_choice: "auto",
      thinking: { type: "disabled" }, stream: false, max_tokens: 1024,
    }, signal);
    const action = decodeDeepSeekAction(payload);
    if (action.kind === "tool" && context.messages.some((message) =>
      message.role === "assistant" && message.action.kind === "tool" &&
      message.action.call.id === action.call.id
    )) {
      throw new Error("Duplicate tool call id in this run");
    }
    console.log(`[模型动作 action] ${action.kind}`);
    return action;
  };
}