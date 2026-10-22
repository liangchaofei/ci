import { join } from "node:path";
import { inspectRecovery } from "../runtime/recovery-reader.ts";
import { inspectWorkspace } from "./recovery-workspace.ts";

const sessionId = process.argv[2] ?? "lesson12";
const base = process.argv[3] ?? ".agent-data";
const decision = await inspectRecovery(base, sessionId, await inspectWorkspace(join(base, "workspace12")));
console.log(`恢复检查（status）: ${decision.status}`);
if (decision.status === "ready") console.log(`已确认消息（messages）: ${decision.result.state.messages.length}`);
else {
  console.log(`停止原因（reason）: ${decision.reason}`);
  console.log(`待核查调用（intents）: ${decision.intents.map((item) => item.id).join(", ") || "无可确认清单"}`);
}