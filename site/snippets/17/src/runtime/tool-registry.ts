import type { Tool } from "./tool.ts";

/** 只公开查找和列名，不允许调用方直接修改内部 Map。 */
export type ToolRegistry = {
  get: (name: string) => Tool | undefined;
  names: () => string[];
};

/** 启动时建立名称索引；重复名称是配置错误，不能静默覆盖。 */
export function createToolRegistry(tools: readonly Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();

  for (const tool of tools) {
    if (tool.name.trim().length === 0) {
      throw new Error("Tool name must not be empty");
    }

    // 重名表示配置冲突，不能让后注册的工具悄悄替换已有实现。
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }

    // 保存名称与入口的当前值，而不是交出可变的注册对象。
    byName.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
      invoke: tool.invoke,
    });
  }

  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}
