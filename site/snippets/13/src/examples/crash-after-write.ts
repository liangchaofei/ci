import { open } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../runtime/agent.ts";
import { createRecoveryStore } from "../runtime/recovery-store.ts";
import { prepareWorkspace, inspectWorkspace } from "./recovery-workspace.ts";

// 仅由故障入口在自己创建的临时目录调用，不用正式会话做破坏实验。
const base = process.argv[2];
if (!base) throw new Error("Temporary base directory is required");
const root = join(base, "workspace12");
await prepareWorkspace(root);
const inspect = () => inspectWorkspace(root, ["append_mark"]);
const store = await createRecoveryStore(base, "fault", inspect, await inspect());
const agent = new Agent({
  decide: async () => ({ kind: "tool", call: { id: "write-1", name: "append_mark", arguments: {} } }),
  executeTool: store.wrap(async (call) => {
    if (call.name !== "append_mark" || Object.keys(call.arguments).length !== 0) throw new Error("Unexpected crash experiment call");
    const file = await open(join(base, "effect.log"), "a");
    try { await file.appendFile("one effect\n"); await file.sync(); }
    finally { await file.close(); }

    // 已写完外部文件，但未交回 ToolResult；刻意跳过正常返回与关闭。
    process.exit(23);
  }),
  validateFinish: () => false,
}, { maxDecisions: 2, resultSink: store });
await agent.run("只用于观察写入后、保存结果前退出的风险");
