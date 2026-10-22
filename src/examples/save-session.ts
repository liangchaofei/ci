import { Agent } from "../runtime/agent.ts";
import { createSessionStore } from "../runtime/session-store.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { hasBatchEvidence } from "./batch-scenario.ts";
import { scriptedInputDecide, steerText } from "./input-scenario.ts";
import { printRunEvent } from "./trace-printer.ts";

const sessionId = process.argv[2] ?? "lesson11";
const base = process.argv[3] ?? ".agent-data";
const finish = process.argv[4] === "finish";
const store = await createSessionStore(base, sessionId);

try {
  const agent = new Agent({
    decide: scriptedInputDecide,
    executeTool: createToolExecutor(createToolRegistry([readSourceTool, readTestsTool])),
    validateFinish: hasBatchEvidence,
  }, { maxDecisions: 5, run: { timeoutMs: 1000 }, resultSink: store });

  agent.subscribe(printRunEvent);
  let paused = false;
  agent.subscribe((event) => {
    if (event.type === "results-recorded" && !paused) { paused = true; agent.pause(); }
  });

  const first = await agent.run("读取源码和测试片段，诊断空数组报错");
  console.log(`已保存结果（savedOutcome）: ${first.outcome.status}`);
  if (finish) {
    const second = await agent.resume(steerText);
    console.log(`已保存续运行（savedOutcome）: ${second.outcome.status}`);
  }
  console.log(`会话目录（directory）: ${store.directory}`);
} finally {
  await store.close();
}