/** 校验成功时交出已确认的参数；失败时不提供可执行参数。 */
export type ParseResult<Args> =
  | { ok: true; value: Args }
  | { ok: false; message: string };

/** 工具内部输出不带调用身份，身份由统一执行入口添加。 */
export type ToolOutput =
  | { status: "ok"; value: unknown }
  | { status: "error"; code: "invalid-arguments"; message: string };

/** 工具入口接收原始参数和本次运行的停止信号。 */
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly invoke: (input: unknown, signal: AbortSignal) => Promise<ToolOutput>;
};

/** 同一个 Args 连接检查结果与执行体；signal 继续传给具体操作。 */
export type ToolDefinition<Args> = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse: (input: unknown) => ParseResult<Args>;
  execute: (args: Args, signal: AbortSignal) => Promise<unknown>;
};

/** 封装校验顺序，使执行体只接收 parse 成功产出的参数。 */
export function defineTool<Args>(definition: ToolDefinition<Args>): Tool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: structuredClone(definition.parameters),
    async invoke(input, signal) {
      signal.throwIfAborted();
      const parsed = definition.parse(input);
      if (!parsed.ok) {
        return { status: "error", code: "invalid-arguments", message: parsed.message };
      }

      // 检查函数也可能触发取消；开始实际操作前再确认一次。
      signal.throwIfAborted();
      const value = await definition.execute(parsed.value, signal);
      return { status: "ok", value };
    },
  };
}