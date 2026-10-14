import { runAgentLoop } from "./runtime/agent-loop.ts";
import { createTextTools } from "./tools/text-tools.ts";
import type { Dependencies } from "./runtime/types.ts";

const mode = process.argv[2] ?? "normal";
if (!["normal", "timeout", "cancel", "model-error"].includes(mode)) throw new Error("Unknown mode");
const caller = new AbortController();
const registry = createTextTools(new Map([["project-name.txt", "CI Agent Harness"]]));
const dependencies: Dependencies = {
  executeToolCall: (call, signal) => registry.execute(call, signal),
  decide: async (state, signal) => {
    if (mode === "model-error") throw new Error("Model unavailable");
    if (mode === "timeout") return new Promise(() => {});
    if (mode === "cancel") { caller.abort(); signal.throwIfAborted(); }
    const observation = state.observations.at(-1);
    if (!observation) return { kind: "tool", call: {
      id: "read-1", name: "read_text", arguments: { path: "project-name.txt" },
    } };
    return observation.status === "ok" && typeof observation.value === "string"
      ? { kind: "finish", answer: observation.value }
      : { kind: "fail", reason: observation.status === "error" ? observation.message : "Bad value" };
  },
  validateFinish: (state, answer) => {
    const observation = state.observations.at(-1);
    return observation?.status === "ok" && observation.toolName === "read_text" && observation.value === answer;
  },
};
const result = await runAgentLoop({ goal: "Read the project name" }, dependencies, 3,
  { timeoutMs: 100, signal: caller.signal });
console.log(`outcome: ${result.outcome.status}`);
console.log(`decisions: ${result.state.decisions}`);
if (result.outcome.status === "completed") console.log(`answer: ${result.outcome.answer}`);
if (result.outcome.status === "failed") {
  console.log(`source: ${result.outcome.source ?? "validation"}`);
  console.log(`reason: ${result.outcome.reason}`);
}
