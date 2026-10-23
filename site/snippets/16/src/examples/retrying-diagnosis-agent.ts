// #region imports
import { Agent } from "../runtime/agent.ts";
import { DependencyError } from "../runtime/dependency-error.ts";
import { createAuthorizedExecutor } from "../runtime/authorization.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import { requestDeepSeek } from "../adapters/deepseek/http.ts";
import { createPermissionWorkspace, createPermissionTools } from "./permission-workspace.ts";
import { runFileProcess } from "./file-process.ts";
import { createRetryReadTool } from "./retry-read-tool.ts";
import { createRetryModelFixture } from "./retry-model-fixture.ts";
import { sourceCode, diagnosis } from "./diagnosis-fixture.ts";
// #endregion imports

// #region prepare
const root = await createPermissionWorkspace();
const getPolicy = () => ({ version: "read-policy-1", allowedTools: ["read_source"] });
const settings = { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100, random: () => 0.5 };
let reads = 0;
const tool = createRetryReadTool(root, getPolicy, {
  ...settings,
  onRetry: (n) => console.log(`[读取重试] 下一次=${n.nextAttempt}，等待=${n.delayMs}ms`),
}, async (signal) => {
  reads += 1;
  console.log(`[只读依赖尝试] ${reads}`);
  if (reads === 1) throw new DependencyError({ source: "tool", kind: "transient", message: "演示：只读服务临时断开" });
  return runFileProcess(root, { kind: "read", path: "sum.ts" }, signal);
});
const registry = createToolRegistry([tool]);
const fixture = createRetryModelFixture();
// #endregion prepare

// #region connect
const decide = createDeepSeekDecider({
  apiKey: "offline-placeholder", model: "offline-fixture", registry, systemPrompt: "读取源码后诊断空数组问题。",
  request: (key, body, signal) => requestDeepSeek(key, body, signal, {
    fetch: fixture.send,
    retry: { ...settings, onRetry: (n) => console.log(`[模型重试] 下一次=${n.nextAttempt}，等待=${n.delayMs}ms`) },
  }),
});
const executeTool = createAuthorizedExecutor({
  getPolicy, inspect: createPermissionTools(root).inspect, execute: createToolExecutor(registry),
  approve: async () => { throw new Error("Read-only run must not request write approval"); }, approvalMs: 1_000,
});
const agent = new Agent({
  decide, executeTool,
  validateFinish: (state, answer) => answer === diagnosis && state.messages.some((message) => {
    if (message.role !== "tool" || message.result.status !== "ok") return false;
    const value = message.result.value;
    return message.result.callId === "read-1" && !!value && typeof value === "object" &&
      "content" in value && value.content === sourceCode;
  }),
}, { maxDecisions: 2, run: { timeoutMs: 10_000 } });
// #endregion connect

// #region run
const result = await agent.run("诊断演示副本中的空数组求和问题；不要修改文件。");
console.log(`[结束状态 outcome] ${result.outcome.status}`);
console.log(`[决策次数 decisions] ${result.state.decisions}`);
console.log(`[模型 HTTP 请求次数] ${fixture.count()}`);
console.log(`[只读依赖尝试次数] ${reads}`);
console.log(`[消息角色 messages] ${result.state.messages.map((m) => m.role).join(" -> ")}`);
// #endregion run
