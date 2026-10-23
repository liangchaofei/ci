import { Agent } from "../../runtime/agent.ts";
import { createModelBudget } from "../../runtime/model-budget.ts";
import { createDeepSeekDecider } from "../../adapters/deepseek/decider.ts";
import { createToolRegistry } from "../../runtime/tool-registry.ts";
import { observe, runCriteria } from "../evidence.ts";
import type { EvaluationCase } from "../contracts.ts";

export const streamCutCase: EvaluationCase = {
  id: "stream-cut", title: "断流：已有完整工具参数，但没有结束标志",
  async run() {
    let executions = 0;
    const budget = createModelBudget({ maxRequests: 2, maxConcurrent: 1, maxKnownTokens: 200, maxEstimatedCostUnits: 300 },
      { inputUnitsPerToken: 1, outputUnitsPerToken: 2 });
    const chunk = { choices: [{ index: 0, finish_reason: "tool_calls", delta: { tool_calls: [
      { index: 0, id: "read-1", type: "function", function: { name: "read_source", arguments: '{"path":"sum.ts"}' } },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
    const decide = createDeepSeekDecider({ apiKey: "offline", model: "offline", systemPrompt: "读取后诊断。",
      registry: createToolRegistry([]), stream: true,
      http: { budget, fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\n`,
        { headers: { "content-type": "text/event-stream" } }) },
    });
    const agent = new Agent({ decide,
      executeTool: async (call) => { executions += 1; return { callId: call.id, status: "ok", value: "must not execute" }; },
      validateFinish: () => false,
    }, { maxDecisions: 3 });
    const trace = observe(agent);
    const result = await agent.run("读取演示源码。");
    return { result, trace, facts: { executions, budget: budget.snapshot() } };
  },
  criteria: [
    { name: "决策未完成", actual: (e) => e.result?.outcome.status, expected: "failed" },
    { name: "确实是协议结束标志缺失", actual: (e) => e.result?.outcome.status === "failed" && e.result.outcome.reason, expected: "Stream ended before [DONE]" },
    { name: "没有接受不完整动作", actual: (e) => e.result?.state.decisions, expected: 0 },
    { name: "工具执行为零", actual: (e) => e.facts.executions, expected: 0 },
    { name: "已报告消耗没有删除", actual: (e) => (e.facts.budget as Record<string, unknown>)?.knownTokens, expected: 20 },
    ...runCriteria(),
  ],
};