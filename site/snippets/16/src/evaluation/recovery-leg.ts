// #region imports
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../runtime/agent.ts";
import { createRecoveryStore } from "../runtime/recovery-store.ts";
import { inspectRecovery } from "../runtime/recovery-reader.ts";
import {
  prepareWorkspace,
  inspectWorkspace,
  createWorkspaceExecutor,
} from "../examples/recovery-workspace.ts";
import { scriptedInputDecide, steerText } from "../examples/input-scenario.ts";
import { hasBatchEvidence } from "../examples/batch-scenario.ts";
import { observe } from "./evidence.ts";
// #endregion imports

// #region run
const mode = process.argv[2];
const base = process.argv[3];
if (!base || !["save", "resume"].includes(mode ?? ""))
  throw new Error("Expected save/resume and temporary directory");

// save 与 resume 都操作父进程指定的同一份演示工作区。
const root = join(base, "workspace12");
await prepareWorkspace(root);
const inspect = () => inspectWorkspace(root);

// 新进程先检查磁盘证据与当前环境，获准后才能恢复。
const decision =
  mode === "resume" ? await inspectRecovery(base, "saved", await inspect()) : undefined;
if (decision?.status === "blocked") throw new Error(decision.reason);

// 新旧运行使用不同保存目录，避免覆盖旧日志。
const store = await createRecoveryStore(
  base,
  mode === "save" ? "saved" : "resumed",
  inspect,
  decision?.status === "ready" ? decision.environment : await inspect(),
);

let executions = 0;
const execute = createWorkspaceExecutor(root);

try {
  const agent = new Agent(
    {
      decide: scriptedInputDecide,
      executeTool: store.wrap(async (call, signal) => {
        // 包在实际执行入口外面，计数不能从预期结果反推。
        executions += 1;

        return execute(call, signal);
      }),
      validateFinish: hasBatchEvidence,
    },
    {
      maxDecisions: 5,
      resultSink: store,
    },
  );

  const trace = observe(agent);

  // 旧进程在真实结果写回后暂停；新进程使用磁盘中确认过的状态。
  if (mode === "save") {
    agent.subscribe((event) => {
      if (event.type === "results-recorded") agent.pause();
    });
  }
  if (decision?.status === "ready") agent.restore(decision.result);

  const result =
    mode === "save"
      ? await agent.run("读取源码和测试，诊断空数组报错")
      : await agent.resume(steerText);

  // 每个进程各写一份证据，由外层恢复场景比较两次运行。
  await writeFile(
    join(base, `${mode}-evidence.json`),
    JSON.stringify({
      result,
      trace,
      facts: { executions },
    }),
  );
} finally {
  // 写盘完成后再退出子进程，不能只依靠终端打印判断保存结束。
  await store.close();
}
// #endregion run
