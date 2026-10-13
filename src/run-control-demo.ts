import { runAgentLoop } from "./runtime/agent-loop.ts";
import type { Dependencies } from "./runtime/types.ts";

const mode = process.argv[2] ?? "normal";
if (!["normal", "timeout", "cancel", "model-error"].includes(mode)) {
  throw new Error("Mode must be normal, timeout, cancel or model-error");
}
const caller = new AbortController();
const files = new Map([["project-name.txt", "CI Agent Harness"]]);

const dependencies: Dependencies = {
  decide: async (state, signal) => {
    if (mode === "model-error") throw new Error("Model unavailable");
    if (mode === "timeout") {
      // 即使适配器忽略信号，Runtime 的等待也必须能退出。
      return new Promise(() => {});
    }
    if (mode === "cancel") {
      caller.abort();
      signal.throwIfAborted();
    }
    const observation = state.observation;
    if (observation === null) return { kind: "read", path: state.targetPath };
    if (observation.kind === "read-failed") return { kind: "fail", reason: observation.reason };
    return { kind: "finish", answer: observation.content };
  },
  executeRead: async (action, signal) => {
    // 依赖也检查信号，避免在已知取消后启动新的动作。
    signal.throwIfAborted();
    const content = files.get(action.path);
    return content === undefined
      ? { kind: "read-failed", path: action.path, reason: "File not found" }
      : { kind: "read-ok", path: action.path, content };
  },
};

const result = await runAgentLoop(
  { targetPath: "project-name.txt" }, dependencies, 3,
  { timeoutMs: 100, signal: caller.signal },
);
console.log(`outcome: ${result.outcome.status}`);
console.log(`decisions: ${result.state.decisions}`);
if (result.outcome.status === "completed") console.log(`answer: ${result.outcome.answer}`);
if (result.outcome.status === "failed") {
  console.log(`source: ${result.outcome.source ?? "validation"}`);
  console.log(`reason: ${result.outcome.reason}`);
}