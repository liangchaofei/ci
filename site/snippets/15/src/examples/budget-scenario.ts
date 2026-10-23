// #region imports
import { Agent } from "../runtime/agent.ts";
import { createModelBudget } from "../runtime/model-budget.ts";
import type { ResourceLimits } from "../runtime/resource-types.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import { createAuthorizedExecutor } from "../runtime/authorization.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createRetryReadTool } from "./retry-read-tool.ts";
import { createPermissionWorkspace, createPermissionTools } from "./permission-workspace.ts";
import { createBudgetModelFixture } from "./budget-model-fixture.ts";
import { sourceCode, diagnosis } from "./diagnosis-fixture.ts";

export const normalLimits: ResourceLimits = { maxRequests: 3, maxConcurrent: 1, maxKnownTokens: 200, maxEstimatedCostUnits: 300 };
// #endregion imports

// #region prepare
/** 两个命令复用同一组装，不在故障入口复制另一套 Runtime。 */
export async function prepareBudgetScenario(limits: ResourceLimits = normalLimits, timeoutMs = 10_000) {
  const root = await createPermissionWorkspace();
  const getPolicy = () => ({ version: "budget-read-1", allowedTools: ["read_source"] });
  const settings = { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100, random: () => 0.5 };
  const tool = createRetryReadTool(root, getPolicy, settings);
  const registry = createToolRegistry([tool]);
  const budget = createModelBudget(limits, { inputUnitsPerToken: 1, outputUnitsPerToken: 2 });
  const fixture = createBudgetModelFixture();
  const decide = createDeepSeekDecider({ apiKey: "offline-placeholder", model: "offline-fixture", registry,
    systemPrompt: "读取源码后诊断空数组问题。", maxOutputTokens: 128,
    http: { fetch: fixture.send, budget, retry: { ...settings,
      onRetry: (n) => console.log(`[模型准备重试] 下一次=${n.nextAttempt}，等待=${n.delayMs}ms`) } },
  });
  const executeTool = createAuthorizedExecutor({
    getPolicy, inspect: createPermissionTools(root).inspect, execute: createToolExecutor(registry),
    approve: async () => false, approvalMs: 1_000,
  });
  const agent = new Agent({ decide, executeTool,
    validateFinish: (state, answer) => answer === diagnosis && state.messages.some((m) => {
      if (m.role !== "tool" || m.result.callId !== "read-1" || m.result.status !== "ok") return false;
      const value = m.result.value;
      return !!value && typeof value === "object" && "content" in value && value.content === sourceCode;
    }),
  }, { maxDecisions: 2, run: { timeoutMs } });
  return { agent, budget, fixture };
}
// #endregion prepare
