// #region contracts
/** 校验成功时交出已确认的参数；失败时不提供可执行参数。 */
export type ParseResult<Args> =
  | { ok: true; value: Args }
  | { ok: false; message: string };

/** 工具内部输出不带调用身份，身份由统一执行入口添加。 */
export type ToolOutput =
  | { status: "ok"; value: unknown }
  | { status: "error"; code: "invalid-arguments"; message: string };

/** 注册表持有的工具入口，原始输入必须经过 invoke 中的校验。 */
export type Tool = {
  readonly name: string;
  readonly invoke: (input: unknown) => Promise<ToolOutput>;
};

/** 同一个 Args 连接校验结果与执行体的参数。 */
export type ToolDefinition<Args> = {
  name: string;
  parse: (input: unknown) => ParseResult<Args>;
  execute: (args: Args) => Promise<unknown>;
};
// #endregion contracts

// #region define
/** 封装校验顺序，使执行体只接收 parse 成功产出的参数。 */
export function defineTool<Args>(definition: ToolDefinition<Args>): Tool {
  return {
    name: definition.name,
    async invoke(input) {
      // 只有 parse 确认的参数才能进入执行体，模型声明不能替代此检查。
      const parsed = definition.parse(input);
      if (!parsed.ok) {
        return { status: "error", code: "invalid-arguments", message: parsed.message };
      }

      // 到这里才开始实际操作；失败校验不会走到 execute。
      const value = await definition.execute(parsed.value);
      return { status: "ok", value };
    },
  };
}
// #endregion define
