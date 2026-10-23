// #region imports
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "../runtime/tool.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { inspectWorkspace } from "./recovery-workspace.ts";
import { readSourceTool, parseReadSourceArgs } from "./read-source-tool.ts";
import { readTestsTool, parseReadTestsArgs } from "./read-tests-tool.ts";
import { sourceCode, diagnosis } from "./diagnosis-fixture.ts";
import { testsCode } from "./batch-fixture.ts";
import type { Operation } from "../runtime/authorization.ts";
import type { State, ToolCall } from "../runtime/types.ts";
// #endregion imports

// #region workspace
/** 对外仍使用原工具契约；执行体读取本次私人目录里的实际文件。 */
export function createIntegratedWorkspace(
  root: string,
  getAllowedTools: () => readonly string[],
) {
  const source = defineTool({
    name: readSourceTool.name,
    description: readSourceTool.description,
    parameters: readSourceTool.parameters,
    parse: parseReadSourceArgs,
    execute: (_args, signal) =>
      readFile(join(root, "sum.ts"), {
        encoding: "utf8",
        signal,
      }),
  });
  const tests = defineTool({
    name: readTestsTool.name,
    description: readTestsTool.description,
    parameters: readTestsTool.parameters,
    parse: parseReadTestsArgs,
    execute: (_args, signal) =>
      readFile(join(root, "sum.test.txt"), {
        encoding: "utf8",
        signal,
      }),
  });
  const registry = createToolRegistry([source, tests]);
  const inspectEnvironment = () => inspectWorkspace(root, [...getAllowedTools()]);

  return {
    registry,
    execute: createToolExecutor(registry),
    inspectEnvironment,
    async inspect(call: ToolCall, signal: AbortSignal): Promise<Operation> {
      signal.throwIfAborted();
      const tool = registry.get(call.name);
      if (!tool) throw new Error("Unknown integration tool");

      // 检查参数与资源版本，不调用 invoke，也不产生工具观察或完成证据。
      const parsed =
        call.name === "read_source"
          ? parseReadSourceArgs(call.arguments)
          : parseReadTestsArgs(call.arguments);
      if (!parsed.ok) throw new Error(parsed.message);

      const environment = await inspectEnvironment();
      signal.throwIfAborted();
      return {
        effect: "read",
        version: environment.revision,
        summary: `read ${call.name}`,
      };
    },
  };
}
// #endregion workspace

// #region validate
/** 只验证固定诊断与两份已读证据；不表示代码已修好或测试已执行。 */
export function validateIntegratedFinish(
  state: Readonly<State>,
  answer: string,
): boolean {
  if (answer !== diagnosis) return false;

  const observations = state.messages.flatMap((message) =>
    message.role === "tool" && message.result.status === "ok" ? [message.result] : [],
  );

  return (
    observations.some(
      (result) => result.callId === "source-1" && result.value === sourceCode,
    ) &&
    observations.some(
      (result) => result.callId === "tests-1" && result.value === testsCode,
    )
  );
}
// #endregion validate
