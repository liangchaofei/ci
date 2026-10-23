// #region imports
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "../runtime/tool.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { parseReadSourceArgs, readSourceTool } from "./read-source-tool.ts";
import { parseReadTestsArgs, readTestsTool } from "./read-tests-tool.ts";
import { sourceCode } from "./diagnosis-fixture.ts";
import { testsCode } from "./batch-fixture.ts";
import type { RecoveryEnvironment } from "../runtime/recovery-types.ts";
// #endregion imports

// #region prepare
/** 只为本章准备固定小工作区；已存在文件保留，不覆盖用户的修改。 */
export async function prepareWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [name, content] of [["sum.ts", sourceCode], ["sum.test.txt", testsCode]]) {
    try { await writeFile(join(root, name), content, { flag: "wx" }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}
// #endregion prepare

// #region inspect
/** 本例只涉及这两个文件；真实应用须覆盖任务所依赖的全部资源。 */
export async function inspectWorkspace(root: string, allowedTools = ["read_source", "read_tests"]): Promise<RecoveryEnvironment> {
  const workspaceId = await realpath(root);
  const files = await Promise.all(["sum.ts", "sum.test.txt"].map(async (name) =>
    [name, (await readFile(join(root, name))).toString("base64")]));
  const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { workspaceId, revision, allowedTools: [...allowedTools] };
}
// #endregion inspect

// #region execute
/** 路径检查沿用旧工具，这次执行体真正读取固定工作区里的文件。 */
export function createWorkspaceExecutor(root: string) {
  const source = defineTool({
    name: readSourceTool.name, description: readSourceTool.description, parameters: readSourceTool.parameters,
    parse: parseReadSourceArgs,
    execute: async (_args, signal) => readFile(join(root, "sum.ts"), { encoding: "utf8", signal }),
  });
  const tests = defineTool({
    name: readTestsTool.name, description: readTestsTool.description, parameters: readTestsTool.parameters,
    parse: parseReadTestsArgs,
    execute: async (_args, signal) => readFile(join(root, "sum.test.txt"), { encoding: "utf8", signal }),
  });
  return createToolExecutor(createToolRegistry([source, tests]));
}
// #endregion execute
