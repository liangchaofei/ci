import { setTimeout as delay } from "node:timers/promises";
import { createToolBatchRunner } from "../runtime/tool-batch.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";
import { readTestsTool } from "./read-tests-tool.ts";
import { batchCalls } from "./batch-fixture.ts";

const mode = process.argv[2] ?? "sequential";
if (mode !== "sequential" && mode !== "parallel") throw new Error("Unknown mode");

const executeTool = createToolExecutor(createToolRegistry([readSourceTool, readTestsTool]));
const runBatch = createToolBatchRunner(async (call, signal) => {
  console.log(`开始调用（start）: ${call.id}`);
  // 只在观察入口延后源码读取，令两个任务的完成顺序可见。
  if (call.name === "read_source") await delay(20, undefined, { signal });

  const result = await executeTool(call, signal);
  console.log(`完成调用（end）: ${call.id}`);
  return result;
}, {
  mode,
  concurrency: 2,
  parallelSafeTools: ["read_source", "read_tests"],
});

const results = await runBatch(batchCalls, new AbortController().signal);
console.log(`返回结果顺序（callIds）: ${results.map((result) => result.callId).join(" -> ")}`);