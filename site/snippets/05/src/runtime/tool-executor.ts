import type { ToolCall, ToolResult } from "./types.ts";
import type { ToolRegistry } from "./tool-registry.ts";

/** 将注册表接到原有 executeTool 接口，不持有或更新 State。 */
export function createToolExecutor(
  registry: ToolRegistry,
): (call: ToolCall, signal: AbortSignal) => Promise<ToolResult> {
  return async (call, signal) => {
    signal.throwIfAborted();

    // 先按名称取得已注册工具，未知名称不能触发任何执行体。
    const tool = registry.get(call.name);
    if (!tool) {
      return {
        callId: call.id,
        status: "error",
        code: "unknown-tool",
        message: `Unknown tool: ${call.name}`,
      };
    }

    try {
      const output = await tool.invoke(call.arguments, signal);

      // 工具只处理参数与值；调用身份统一取自原请求。
      return { ...output, callId: call.id };
    } catch (error) {
      return {
        callId: call.id,
        status: "error",
        code: "tool-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
