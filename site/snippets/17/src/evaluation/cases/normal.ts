// #region normal
import { prepareBudgetScenario, normalLimits } from "../../examples/budget-scenario.ts";
import { observe, runCriteria } from "../evidence.ts";
import { sourceCode } from "../../examples/diagnosis-fixture.ts";
import type { EvaluationCase } from "../contracts.ts";

/** 沿用第 15 篇任务，只增加观察与判定，不替换原运行循环。 */
export const normalCase: EvaluationCase = {
  id: "normal",
  title: "正常多轮：503 恢复后，读取证据进入下一轮",
  async run() {
    const { agent, budget, fixture, requestBodies } = await prepareBudgetScenario();

    // 先订阅再启动，确保 run-started 也在证据中。
    const trace = observe(agent);
    const result = await agent.run("诊断演示副本的空数组问题，不修改文件。");

    // 结果、传输计数与实际请求体分别取自运行对象，不用期望值填充。
    return {
      result,
      trace,
      facts: {
        budget: budget.snapshot(),
        httpCalls: fixture.count(),
        lastModelMessages: requestBodies.at(-1)?.messages,
        toolIds: result.state.messages
          .filter((m) => m.role === "tool")
          .map((m) => m.result.callId),
      },
    };
  },

  // 这些期望在运行前固定；判定器稍后从真实证据逐项提取。
  criteria: [
    {
      name: "任务完成",
      actual: (e) => e.result?.outcome.status,
      expected: "completed",
    },
    {
      name: "两次已记录决策",
      actual: (e) => e.result?.state.decisions,
      expected: 2,
    },
    {
      name: "只有一次读取观察",
      actual: (e) => e.facts.toolIds,
      expected: ["read-1"],
    },
    {
      name: "HTTP 尝试含重试共三次",
      actual: (e) => (e.facts.budget as Record<string, unknown>)?.requests,
      expected: 3,
    },
    {
      name: "已报告 token 为 120",
      actual: (e) => (e.facts.budget as Record<string, unknown>)?.knownTokens,
      expected: 120,
    },
    {
      name: "估算费用仍为演示单位 140",
      actual: (e) => (e.facts.budget as Record<string, unknown>)?.estimatedCostUnits,
      expected: 140,
    },
    {
      name: "无报告失败仍被单独记录",
      actual: (e) => (e.facts.budget as Record<string, unknown>)?.unreportedRequests,
      expected: 1,
    },
    {
      name: "正常结束没有遗留活动凭条",
      actual: (e) => (e.facts.budget as Record<string, unknown>)?.active,
      expected: 0,
    },
    {
      name: "正常阶段顺序符合本任务",
      actual: (e) => e.trace.map((t) => t.type),
      expected: [
        "run-started",
        "decision-started",
        "decision-recorded",
        "batch-started",
        "results-recorded",
        "decision-started",
        "decision-recorded",
        "run-ended",
      ],
    },
    {
      name: "服务替身实际调用为三次",
      actual: (e) => e.facts.httpCalls,
      expected: 3,
    },
    // #region feedback
    {
      name: "下一次模型输入确实带源码",
      actual: (e) => {
        const messages = e.facts.lastModelMessages;
        if (!Array.isArray(messages)) return false;

        // State 有源码还不够，要查最后一次传输给模型的消息。
        const tool = messages.find(
          (m) => m?.role === "tool" && m.tool_call_id === "read-1",
        );

        return tool && JSON.parse(tool.content).value.content === sourceCode;
      },
      expected: true,
    },
    // #endregion feedback
    ...runCriteria(),
  ],
};
// #endregion normal

// #region budget
/** 只改请求上限；第三次传输应被原预算门禁拦住。 */
export const requestLimitCase: EvaluationCase = {
  id: "request-limit",
  title: "请求额度：保留读取事实，不发第三次传输",
  async run() {
    const { agent, budget, fixture, requestBodies } = await prepareBudgetScenario({
      ...normalLimits,
      maxRequests: 2,
    });

    // 先订阅再启动，确保 run-started 也在证据中。
    const trace = observe(agent);
    const result = await agent.run("诊断演示副本，不修改文件。");

    // 结果、传输计数与实际请求体分别取自运行对象，不用期望值填充。
    return {
      result,
      trace,
      facts: {
        budget: budget.snapshot(),
        httpCalls: fixture.count(),
        lastModelMessages: requestBodies.at(-1)?.messages,
        toolResults: result.state.messages.filter((m) => m.role === "tool").length,
      },
    };
  },

  // 这些期望在运行前固定；判定器稍后从真实证据逐项提取。
  criteria: [
    {
      name: "资源出口",
      actual: (e) => e.result?.outcome.status,
      expected: "resource-limit",
    },
    {
      name: "额度类别正确",
      actual: (e) =>
        e.result?.outcome.status === "resource-limit" && e.result.outcome.resource,
      expected: "model-requests",
    },
    {
      name: "只准入两次 HTTP",
      actual: (e) => (e.facts.budget as Record<string, unknown>)?.requests,
      expected: 2,
    },
    {
      name: "第三次传输依赖没有启动",
      actual: (e) => e.facts.httpCalls,
      expected: 2,
    },
    {
      name: "已有读取结果仍保留",
      actual: (e) => e.facts.toolResults,
      expected: 1,
    },
    ...runCriteria(),
  ],
};
// #endregion budget
