// #region contracts
import { createRunControl } from "./run-control.ts";
import type { ToolCall, ToolResult } from "./types.ts";

/** 应用持有的当前规则；不能从模型参数或旧会话恢复授权。 */
export type ExecutionPolicy = { version: string; allowedTools: readonly string[] };
export type Operation = { effect: "read" | "write"; version: string; summary: string };
export type ApprovalRequest = {
  call: ToolCall;
  operation: Operation;
  policyVersion: string;
  expiresAt: number;
};
export type AuthorizationOptions = {
  getPolicy: () => ExecutionPolicy;
  inspect: (call: ToolCall, signal: AbortSignal) => Promise<Operation>;
  approve: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
  execute: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
  approvalMs: number;
};
// #endregion contracts

// #region approval
/** 只等待这一份写请求的回答；返回批准仍可使用的截止时刻。 */
async function waitForApproval(
  call: ToolCall,
  operation: Operation,
  policyVersion: string,
  options: AuthorizationOptions,
  signal: AbortSignal,
): Promise<number> {
  const deadline = performance.now() + options.approvalMs;
  const control = createRunControl({ signal, timeoutMs: options.approvalMs });
  try {
    const request = { call, operation, policyVersion, expiresAt: Date.now() + options.approvalMs };
// #region wait-call
    const approved = await control.wait((approvalSignal) =>
      options.approve(structuredClone(request), approvalSignal));
    control.check();
// #endregion wait-call
    if (!approved) throw new Error("approval-denied: user declined");
    return deadline;
  } catch (error) {
    if (control.outcome()?.status === "timed-out") throw new Error("approval-expired: ask again");
    throw error;
  } finally {
    control.dispose();
  }
}
// #endregion approval

// #region executor
/** 每个实例对应一个工作区；串行化检查与执行，不把批准变成可复用令牌。 */
export function createAuthorizedExecutor(options: AuthorizationOptions) {
  if (!Number.isInteger(options.approvalMs) || options.approvalMs < 1 || options.approvalMs > 2_147_483_647) {
    throw new RangeError("Invalid approvalMs");
  }

  let tail: Promise<unknown> = Promise.resolve();
  const usedIds = new Set<string>();

  async function run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    try {
      signal.throwIfAborted();
      if (usedIds.has(call.id)) throw new Error("call-reused: request a new call ID");
      usedIds.add(call.id);

// #region admission
      const policy = structuredClone(options.getPolicy());
      if (!policy.allowedTools.includes(call.name)) throw new Error("policy-denied: tool not allowed");

      // inspect 负责本工具的参数、路径和当前资源检查，不执行写入。
      const operation = await options.inspect(structuredClone(call), signal);
      signal.throwIfAborted();
// #endregion admission

      let approvalDeadline: number | undefined;
      if (operation.effect === "write") {
        approvalDeadline = await waitForApproval(call, operation, policy.version, options, signal);
      }

// #region recheck
      // 等人批准期间规则和文件都可能变化；只批准刚才那份请求。
      signal.throwIfAborted();
      if (JSON.stringify(options.getPolicy()) !== JSON.stringify(policy)) {
        throw new Error("policy-changed: ask again under current policy");
      }
      const current = await options.inspect(structuredClone(call), signal);
      if (JSON.stringify(current) !== JSON.stringify(operation)) throw new Error("resource-changed: read again");
      signal.throwIfAborted();

      if (approvalDeadline !== undefined && performance.now() >= approvalDeadline) {
        throw new Error("approval-expired: ask again");
      }
// #endregion recheck
    } catch (error) {
      // 取消仍交给原循环处理，不伪装成一次可继续的工具拒绝。
      signal.throwIfAborted();
      return { callId: call.id, status: "error", code: "permission-denied",
        message: error instanceof Error ? error.message : String(error) };
    }

    // 已进入实际执行的异常不能改称“未获许可”；沿原执行失败路径交回。
    return await options.execute(call, signal);
  }

  return (input: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
// #region queue
    // 在入队时复制；排队期间调用方修改原对象也不能换掉待批准参数。
    const call = structuredClone(input);
    const result = tail.then(() => run(call, signal));
    tail = result.catch(() => undefined);
    return result;
// #endregion queue
  };
}
// #endregion executor
