import { defineTool } from "../runtime/tool.ts";
import type { ParseResult } from "../runtime/tool.ts";
import { testsPath, testsCode } from "./batch-fixture.ts";

type ReadTestsArgs = { path: string };


export function parseReadTestsArgs(input: unknown): ParseResult<ReadTestsArgs> {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      !("path" in input) || input.path !== testsPath ||
      Object.keys(input).some((key) => key !== "path")) {
    return { ok: false, message: "Only the fixed test path is allowed" };
  }

  return { ok: true, value: { path: testsPath } };
}

/** 与读取源码相互独立；返回固定片段，不执行测试或修改文件。 */
export const readTestsTool = defineTool<ReadTestsArgs>({
  name: "read_tests",
  description: "读取已有测试片段；本例仅提供 test/sum.test.ts。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", enum: [testsPath] } },
    required: ["path"],
    additionalProperties: false,
  },
  parse: parseReadTestsArgs,
  async execute() {
    return testsCode;
  },
});