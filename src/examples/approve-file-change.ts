import { createInterface } from "node:readline/promises";
import { Agent } from "../runtime/agent.ts";
import { createAuthorizedExecutor } from "../runtime/authorization.ts";
import type { ApprovalRequest } from "../runtime/authorization.ts";
import { createPermissionWorkspace, createPermissionTools } from "./permission-workspace.ts";
import { permissionDecide, hasWriteEvidence } from "./permission-scenario.ts";

/** 独立 CLI 的人工入口；回答只批准眼前这一份请求，不生成长期授权。 */
async function askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
  console.log(`[等待批准] 调用=${request.call.id}，操作=${request.operation.summary}`);
  console.log(`[原文件版本] ${request.operation.version}`);
  console.log(`[拟写入内容]\n${request.call.arguments.content}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("允许本次写入？输入 yes，其余回答拒绝：", { signal });
    return answer.trim() === "yes";
  } finally {
    terminal.close();
  }
}

const root = await createPermissionWorkspace();
const tools = createPermissionTools(root);
const executeTool = createAuthorizedExecutor({
  getPolicy: () => ({ version: "policy-1", allowedTools: ["read_source", "write_source"] }),
  inspect: tools.inspect, execute: tools.execute, approve: askApproval, approvalMs: 60_000,
});
const agent = new Agent({ decide: permissionDecide, executeTool, validateFinish: hasWriteEvidence },
  { maxDecisions: 3, run: { timeoutMs: 120_000 } });

console.log(`[演示工作区] ${root}`);
const result = await agent.run("在批准后，为演示副本的 sum 添加初始值 0。");
console.log(`[结束状态 outcome] ${result.outcome.status}`);
console.log(`[决策次数 decisions] ${result.state.decisions}`);
console.log(`[结束详情] ${JSON.stringify(result.outcome)}`);