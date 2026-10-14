import { runAgentLoop } from "./runtime/agent-loop.ts";
import { createTextTools } from "./tools/text-tools.ts";
import type { Dependencies } from "./runtime/types.ts";

const targetPath = process.argv[2] ?? "project-name.txt";
const registry = createTextTools(new Map([["project-name.txt", "CI Agent Harness"]]));
const dependencies: Dependencies = {
  executeToolCall: (call, signal) => registry.execute(call, signal),
  decide: async (state) => {
    const observation = state.observations.at(-1);
    if (!observation) return { kind: "tool", call: {
      id: "read-1", name: "read_text", arguments: { path: targetPath },
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
const result = await runAgentLoop({ goal: `Read ${targetPath}` }, dependencies, 3);
console.log(`outcome: ${result.outcome.status}`);
if (result.outcome.status === "completed") console.log(`answer: ${result.outcome.answer}`);
if (result.outcome.status === "failed") console.log(`reason: ${result.outcome.reason}`);
