import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../runtime/agent.ts";
import { createRecoveryStore } from "../runtime/recovery-store.ts";
import { inspectRecovery } from "../runtime/recovery-reader.ts";
import { prepareWorkspace, inspectWorkspace, createWorkspaceExecutor } from "../examples/recovery-workspace.ts";
import { scriptedInputDecide, steerText } from "../examples/input-scenario.ts";
import { hasBatchEvidence } from "../examples/batch-scenario.ts";
import { observe } from "./evidence.ts";

const mode = process.argv[2];
const base = process.argv[3];
if (!base || !["save", "resume"].includes(mode ?? "")) throw new Error("Expected save/resume and temporary directory");
const root = join(base, "workspace12");
await prepareWorkspace(root);
const inspect = () => inspectWorkspace(root);
const decision = mode === "resume" ? await inspectRecovery(base, "saved", await inspect()) : undefined;
if (decision?.status === "blocked") throw new Error(decision.reason);
const store = await createRecoveryStore(base, mode === "save" ? "saved" : "resumed", inspect,
  decision?.status === "ready" ? decision.environment : await inspect());
let executions = 0;
const execute = createWorkspaceExecutor(root);
try {
  const agent = new Agent({ decide: scriptedInputDecide,
    executeTool: store.wrap(async (call, signal) => { executions += 1; return execute(call, signal); }),
    validateFinish: hasBatchEvidence,
  }, { maxDecisions: 5, resultSink: store });
  const trace = observe(agent);
  if (mode === "save") agent.subscribe((event) => { if (event.type === "results-recorded") agent.pause(); });
  if (decision?.status === "ready") agent.restore(decision.result);
  const result = mode === "save" ? await agent.run("读取源码和测试，诊断空数组报错") : await agent.resume(steerText);
  await writeFile(join(base, `${mode}-evidence.json`), JSON.stringify({ result, trace, facts: { executions } }));
} finally {
  await store.close();
}