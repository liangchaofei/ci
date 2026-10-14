import { runAgentLoop } from "./runtime/agent-loop.ts";
import { createTextTools } from "./tools/text-tools.ts";
import type { Dependencies } from "./runtime/types.ts";

const mode = process.argv[2] ?? "normal";
const registry = createTextTools(new Map([["project-name.txt", "CI Agent Harness"]]));
const dependencies: Dependencies = {
  executeToolCall: (call, signal) => registry.execute(call, signal),
  decide: async (state) => {
    const last = state.observations.at(-1);
    if (last?.status === "error") return { kind: "fail", reason: last.message };
    if (state.observations.length === 0) {
      return { kind: "tool", call: { id: "read-1", name: "read_text",
        arguments: { path: mode === "invalid" ? 42 : "project-name.txt" } } };
    }
    if (last?.status === "ok" && last.toolName === "read_text" && typeof last.value === "string") {
      return { kind: "tool", call: { id: "length-1", name: "text_length", arguments: { text: last.value } } };
    }
    if (last?.status === "ok" && typeof last.value === "number") {
      return { kind: "finish", answer: String(last.value) };
    }
    return { kind: "fail", reason: "Unexpected observation" };
  },
  validateFinish: (state, answer) => {
    const read = state.observations.find((o) => o.status === "ok" && o.toolName === "read_text");
    const length = state.observations.find((o) => o.status === "ok" && o.toolName === "text_length");
    return read?.status === "ok" && typeof read.value === "string"
      && length?.status === "ok" && length.value === read.value.length
      && answer === String(length.value);
  },
};
const result = await runAgentLoop({ goal: "Read the project name and count its UTF-16 code units" }, dependencies, 4);
for (const event of result.events) {
  if (event.kind === "decision") {
    console.log(`decision ${event.index}: ${event.action.kind}`);
  } else {
    console.log(`tool ${event.observation.toolName}: ${event.observation.status}`);
  }
}
console.log(`outcome: ${result.outcome.status}`);
if (result.outcome.status === "completed") console.log(`answer: ${result.outcome.answer}`);
if (result.outcome.status === "failed") console.log(`reason: ${result.outcome.reason}`);
