import type { JsonValue, ToolCall, ToolDefinition, ToolResult } from "./types.ts";

type RegisteredTool = {
  description: string;
  invoke: (input: unknown, signal: AbortSignal) => Promise<
    | { status: "ok"; value: JsonValue }
    | { status: "error"; code: "invalid-arguments" | "execution-failed"; message: string }
  >;
};
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 工具按名称注册；泛型输入留在闭包中，不把 unknown 断言为已校验参数。 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<Input, Output extends JsonValue>(definition: ToolDefinition<Input, Output>): void {
    if (!definition.name.trim()) throw new Error("Tool name must not be empty");
    if (this.tools.has(definition.name)) throw new Error("Duplicate tool name");
    // 注册时保存契约，不依赖调用方之后修改 definition 对象。
    const { name, description, parse, execute } = definition;
    this.tools.set(name, {
      description,
      invoke: async (input, signal) => {
        signal.throwIfAborted();
        let parsed: Input;
        try {
          parsed = parse(input);
        } catch (error) {
          signal.throwIfAborted();
          return { status: "error", code: "invalid-arguments", message: messageOf(error) };
        }
        signal.throwIfAborted();
        try {
          const value = await execute(parsed, signal);
          signal.throwIfAborted();
          return { status: "ok", value };
        } catch (error) {
          // 运行停止继续向上传递，不包装成普通工具失败。
          signal.throwIfAborted();
          return { status: "error", code: "execution-failed", message: messageOf(error) };
        }
      },
    });
  }

  list(): { name: string; description: string }[] {
    return [...this.tools].map(([name, tool]) => ({ name, description: tool.description }));
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { callId: call.id, toolName: call.name, status: "error",
        code: "unknown-tool", message: "Tool not registered" };
    }
    const result = await tool.invoke(call.arguments, signal);
    return { callId: call.id, toolName: call.name, ...result };
  }
}
