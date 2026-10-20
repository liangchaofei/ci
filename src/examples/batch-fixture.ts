import type { ToolCall } from "../runtime/types.ts";
import { sourcePath } from "./diagnosis-fixture.ts";

/** 现有测试片段的固定替身，不会在本章创建或运行这个测试文件。 */
export const testsPath = "test/sum.test.ts";
export const testsCode = "assert.equal(sum([1, 2]), 3);";

/** 两次独立只读请求，身份不同；数组顺序是本批记录顺序。 */
export const batchCalls: ToolCall[] = [
  { id: "source-1", name: "read_source", arguments: { path: sourcePath } },
  { id: "tests-1", name: "read_tests", arguments: { path: testsPath } },
];