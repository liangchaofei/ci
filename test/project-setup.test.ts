import assert from "node:assert/strict";
import { test } from "node:test";
import { projectName } from "../src/project-info.ts";

test("Node can import and test our TypeScript source", () => {
  // 用真实的类型标注，验证 Node 能直接运行 .ts 测试文件。
  const actual: string = projectName;
  assert.equal(actual, "CI Agent Harness");
});
