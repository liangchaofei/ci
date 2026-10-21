// #region imports
import { runAgentLoop } from "../runtime/agent-loop.ts";
import type { Dependencies, RunResult, ToolResult } from "../runtime/types.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { hasDiagnosisEvidence, scriptedDecide } from "./diagnosis-scenario.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { sourceCallId, sourceCode } from "./diagnosis-fixture.ts";
// #endregion imports

// #region shared
const dependencies: Dependencies = {
  decide: scriptedDecide,
  executeTool: createToolExecutor(createToolRegistry([readSourceTool])),
  validateFinish: hasDiagnosisEvidence,
};
function show(result: RunResult): void {
  console.log(`运行结果（outcome）: ${result.outcome.status}`);
  console.log(`决策次数（decisions）: ${result.state.decisions}`);
  console.log(`消息顺序（messages）: ${result.state.messages.map((m) => m.role).join(" -> ")}`);
}

const goal = "Diagnose why sum([]) fails";
// #endregion shared

// #region basic
const mode = process.argv[2] ?? "normal";
if (mode === "normal" || mode === "budget") {
  show(await runAgentLoop(goal, dependencies, mode === "budget" ? 1 : 3));
} else if (mode === "timeout") {
  const hanging: Dependencies = {
    ...dependencies,
    decide: () => new Promise<never>(() => {}),
  };
  show(await runAgentLoop(goal, hanging, 3, { timeoutMs: 30 }));
} else if (mode === "cancel-before") {
  const controller = new AbortController();
  controller.abort();
  show(await runAgentLoop(goal, dependencies, 3, { signal: controller.signal }));
// #endregion basic
// #region late
} else if (mode === "cancel-execution") {
  const controller = new AbortController();
  let deliver: ((result: ToolResult) => void) | undefined;
  let executionSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const delayed: Dependencies = {
    ...dependencies,
    executeTool: (_call, signal) => new Promise<ToolResult>((resolve) => {
      deliver = resolve;
      executionSignal = signal;
      console.log("等待位置（stage）: 工具已开始，但还没有结果");
      markStarted?.();
    }),
  };

  const running = runAgentLoop(goal, delayed, 3, { signal: controller.signal });

  // 等到工具确实开始，再取消，才能稳定观察执行中的停止行为。
  await started;
  controller.abort();

  const result = await running;
  show(result);
  console.log(`工具收到取消（aborted）: ${executionSignal?.aborted}`);

  // 故意模拟不配合取消的工具，运行退出以后才交出结果。
  deliver?.({ callId: sourceCallId, status: "ok", value: sourceCode });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  console.log(`迟到后消息数（messagesAfterLateResult）: ${result.state.messages.length}`);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
// #endregion late
