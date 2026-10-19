import { defineTool } from "../runtime/tool.ts";
import type { ParseResult } from "../runtime/tool.ts";
import { sourceCode, sourcePath } from "./diagnosis-fixture.ts";


/** 本例读取体只接受这一种已经校验的参数。 */
type ReadSourceArgs = { path: string };

function parseReadSourceArgs(input: unknown): ParseResult<ReadSourceArgs> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "Arguments must be an object" };
  }
  if (!("path" in input) || typeof input.path !== "string" || input.path.trim() === "") {
    return { ok: false, message: "path must be a non-empty string" };
  }
  if (Object.keys(input).some((key) => key !== "path")) {
    return { ok: false, message: "Unexpected argument" };
  }
  if (input.path !== sourcePath) {
    return { ok: false, message: "Source path is not allowed" };
  }

  // 返回新对象，执行体不再直接接收未确认的原始输入。
  return { ok: true, value: { path: input.path } };
}


/** 仍是模拟读取；执行日志只出现在校验通过后的工具体中。 */
export const readSourceTool = defineTool<ReadSourceArgs>({
  name: "read_source",
  parse: parseReadSourceArgs,
  async execute(args) {
    console.log(`[执行工具 execute] read_source 文件路径（path）=${args.path}`);
    return sourceCode;
  },
});