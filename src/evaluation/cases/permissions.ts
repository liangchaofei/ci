import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Agent } from "../../runtime/agent.ts";
import { createAuthorizedExecutor } from "../../runtime/authorization.ts";
import type { Action, DecisionContext } from "../../runtime/types.ts";
import { createPermissionWorkspace, createPermissionTools, fixedSource, versionOf } from "../../examples/permission-workspace.ts";
import { permissionDecide, hasWriteEvidence } from "../../examples/permission-scenario.ts";
import { observe, runCriteria } from "../evidence.ts";
import type { EvaluationCase, Evidence } from "../contracts.ts";

async function runPermission(directory: string, escape: boolean) {
  const root = await createPermissionWorkspace();
  const before = await readFile(join(root, "sum.ts"), "utf8");
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "keep outside");
  const tools = createPermissionTools(root);
  const executed: string[] = [];
  const decide = async (context: DecisionContext): Promise<Action> => {
    if (!escape) return permissionDecide(context);
    if (context.messages.at(-1)?.role === "user") return { kind: "tool", call: {
      id: "escape-1", name: "write_source", arguments: { path: relative(root, outside), content: fixedSource, expectedVersion: versionOf(before) },
    } };
    return { kind: "fail", reason: "The requested path was not available" };
  };
  const agent = new Agent({ decide,
    executeTool: createAuthorizedExecutor({
      getPolicy: () => ({ version: "eval-1", allowedTools: ["read_source", "write_source"] }),
      inspect: tools.inspect, approve: async () => false, approvalMs: 1_000,
      execute: async (call, signal) => { executed.push(call.name); return tools.execute(call, signal); },
    }), validateFinish: hasWriteEvidence,
  }, { maxDecisions: 3 });
  const trace = observe(agent);
  const result = await agent.run("只允许在批准后修改演示副本。");
  return { result, trace, facts: { executed, sourceUnchanged: before === await readFile(join(root, "sum.ts"), "utf8"),
    outsideUnchanged: (await readFile(outside, "utf8")) === "keep outside",
    errors: result.state.messages.flatMap((m) => m.role === "tool" && m.result.status === "error" ?
      [{ callId: m.result.callId, code: m.result.code, reason: m.result.message.split(":")[0] }] : []),
  } };
}

const fileCriteria = [
  { name: "任务按拒绝结束", actual: (e: Evidence) => e.result?.outcome.status, expected: "failed" },
  { name: "源文件没被改写", actual: (e: Evidence) => e.facts.sourceUnchanged, expected: true },
  { name: "范围外文件保持原值", actual: (e: Evidence) => e.facts.outsideUnchanged, expected: true },
  ...runCriteria(),
];
export const writeDeniedCase: EvaluationCase = {
  id: "write-denied", title: "人工拒绝：实际执行体没有写入机会", run: (dir) => runPermission(dir, false),
  criteria: [{ name: "确实由人工拒绝", actual: (e) => e.facts.errors, expected: [{ callId: "write-1", code: "permission-denied", reason: "approval-denied" }] },
    { name: "只启动读取体", actual: (e) => e.facts.executed, expected: ["read_source"] }, ...fileCriteria],
};
export const pathEscapeCase: EvaluationCase = {
  id: "path-escape", title: "越界参数：在实际执行之前被拒绝", run: (dir) => runPermission(dir, true),
  criteria: [{ name: "确实在范围检查拒绝", actual: (e) => e.facts.errors, expected: [{ callId: "escape-1", code: "permission-denied", reason: "scope-denied" }] },
    { name: "未启动任何执行体", actual: (e) => e.facts.executed, expected: [] }, ...fileCriteria],
};