import { Agent } from "../../runtime/agent.ts";
import type { ToolResult } from "../../runtime/types.ts";
import { deferred, nextTurn } from "../deferred.ts";
import { observe, runCriteria } from "../evidence.ts";
import type { EvaluationCase } from "../contracts.ts";

export const lateCancelCase: EvaluationCase = {
  id: "late-cancel", title: "取消：忽略停止的工具迟到返回，也不能写回状态",
  async run() {
    const started = deferred<void>();
    const late = deferred<ToolResult>();
    const returned = deferred<void>();
    const agent = new Agent({
      decide: async () => ({ kind: "tool", call: { id: "read-1", name: "read_source", arguments: {} } }),
      executeTool: async () => { started.resolve(); const value = await late.promise; returned.resolve(); return value; },
      validateFinish: () => false,
    }, { maxDecisions: 2 });
    const trace = observe(agent);
    const pending = agent.run("观察取消后的迟到读取。");
    await started.promise;
    agent.cancel();
    const result = await pending;
    const before = JSON.stringify(agent.result);
    const traceBefore = JSON.stringify(trace);
    late.resolve({ callId: "read-1", status: "ok", value: "late source" });
    await returned.promise;
    await nextTurn();
    return { result, trace, facts: { stateUnchanged: before === JSON.stringify(agent.result),
      traceUnchanged: traceBefore === JSON.stringify(trace), toolResults: result.state.messages.filter((m) => m.role === "tool").length } };
  },
  criteria: [
    { name: "原退出是取消", actual: (e) => e.result?.outcome.status, expected: "cancelled" },
    { name: "迟到后实例结果不变", actual: (e) => e.facts.stateUnchanged, expected: true },
    { name: "迟到后不补发运行事件", actual: (e) => e.facts.traceUnchanged, expected: true },
    { name: "没有迟到工具观察", actual: (e) => e.facts.toolResults, expected: 0 }, ...runCriteria(),
  ],
};

export const parallelOrderCase: EvaluationCase = {
  id: "parallel-order", title: "并行：测试先返回，保存顺序仍对应原请求",
  async run() {
    const bothStarted = deferred<void>();
    const source = deferred<string>();
    const tests = deferred<string>();
    const testsReturned = deferred<void>();
    let active = 0;
    let peak = 0;
    const completed: string[] = [];
    const agent = new Agent({
      decide: async (context) => context.messages.at(-1)?.role === "user" ? { kind: "tools", calls: [
        { id: "source-1", name: "read_source", arguments: {} }, { id: "tests-1", name: "read_tests", arguments: {} },
      ] } : { kind: "finish", answer: "两份材料已返回" },
      executeTool: async (call) => {
        active += 1; peak = Math.max(peak, active); if (active === 2) bothStarted.resolve();
        const value = await (call.id === "source-1" ? source.promise : tests.promise);
        completed.push(call.id); active -= 1;
        if (call.id === "tests-1") testsReturned.resolve();
        return { callId: call.id, status: "ok", value };
      },
      validateFinish: (state) => state.messages.filter((m) => m.role === "tool").length === 2,
    }, { maxDecisions: 2, run: { toolExecution: { mode: "parallel", concurrency: 2, parallelSafeTools: ["read_source", "read_tests"] } } });
    const trace = observe(agent);
    const pending = agent.run("读取源码与测试。");
    await bothStarted.promise;
    tests.resolve("tests"); await testsReturned.promise; source.resolve("source");
    const result = await pending;
    return { result, trace, facts: { peak, completed,
      saved: result.state.messages.filter((m) => m.role === "tool").map((m) => ({ id: m.result.callId, value: m.result.status === "ok" ? m.result.value : null })) } };
  },
  criteria: [
    { name: "任务完成", actual: (e) => e.result?.outcome.status, expected: "completed" },
    { name: "确实有两个同时在等", actual: (e) => e.facts.peak, expected: 2 },
    { name: "完成顺序被确定反转", actual: (e) => e.facts.completed, expected: ["tests-1", "source-1"] },
    { name: "保存顺序与身份值均正确", actual: (e) => e.facts.saved, expected: [{ id: "source-1", value: "source" }, { id: "tests-1", value: "tests" }] },
    ...runCriteria(),
  ],
};