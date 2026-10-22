// #region imports
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAuthorizedExecutor } from "../runtime/authorization.ts";
import type { AuthorizationOptions } from "../runtime/authorization.ts";
import { createPermissionWorkspace, createPermissionTools, fixedSource, versionOf } from "./permission-workspace.ts";
// #endregion imports

// #region experiment
/** 每项实验使用全新副本；这里的自动回答只服务故障复现，不是产品的人工批准。 */
async function experiment(mode: "deny" | "expired" | "changed" | "policy" | "scope" | "reused"): Promise<void> {
  const root = await createPermissionWorkspace();
  const tools = createPermissionTools(root);
  const before = await readFile(join(root, "sum.ts"), "utf8");
  let executions = 0;
  const approve: AuthorizationOptions["approve"] = async () => {
    if (mode === "expired") return new Promise<boolean>(() => undefined);
    if (mode === "changed") await writeFile(join(root, "sum.ts"), "// 外部编辑，不是工具写入");
    return mode !== "deny" && mode !== "reused";
  };
  const execute = createAuthorizedExecutor({
    getPolicy: () => ({ version: "fault-1", allowedTools: mode === "policy" ? [] : ["write_source"] }),
    inspect: tools.inspect, approve, approvalMs: mode === "expired" ? 30 : 1_000,
    execute: async (call, signal) => { executions += 1; return tools.execute(call, signal); },
  });
  const call = { id: "write-1", name: "write_source", arguments: {
    path: mode === "scope" ? "../sum.ts" : "sum.ts", content: fixedSource, expectedVersion: versionOf(before),
  } };
  const signal = new AbortController().signal;
  let result = await execute(call, signal);
  if (mode === "reused") result = await execute(call, signal);
  const after = await readFile(join(root, "sum.ts"), "utf8");
  console.log(`[${mode}] 执行次数=${executions}，文件相同=${before === after}`);
  console.log(`[拒绝详情] ${JSON.stringify(result)}`);
}
// #endregion experiment

// #region main
for (const mode of ["deny", "expired", "changed", "policy", "scope", "reused"] as const) {
  await experiment(mode);
}
// #endregion main
