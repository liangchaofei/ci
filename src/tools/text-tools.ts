import { ToolRegistry } from "../runtime/tool-registry.ts";

function field(input: unknown, name: string): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Arguments must be an object");
  }
  const value = Object.getOwnPropertyDescriptor(input, name)?.value;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

/** 本章仅访问给定 Map；路径范围由工具的应用配置决定。 */
export function createTextTools(files: ReadonlyMap<string, string>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_text", description: "Read a text value from the allowed in-memory file map",
    parse: (input) => {
      const path = field(input, "path");
      if (!files.has(path)) throw new Error("Path is outside the allowed file set");
      return path;
    },
    execute: async (path, signal) => {
      signal.throwIfAborted();
      const value = files.get(path);
      if (value === undefined) throw new Error("File disappeared");
      return value;
    },
  });
  registry.register({
    name: "text_length", description: "Count JavaScript UTF-16 code units in text",
    parse: (input) => field(input, "text"),
    execute: async (text, signal) => { signal.throwIfAborted(); return text.length; },
  });
  return registry;
}
