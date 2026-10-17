import { runAgentLoop } from "./runtime/agent-loop.ts";
import { createContextDecision } from "./runtime/context.ts";
import { createTextTools } from "./tools/text-tools.ts";
import type { Dependencies } from "./runtime/types.ts";

const mode = process.argv[2] ?? "normal";
const registry = createTextTools(new Map([["project-name.txt", "CI Agent Harness"]]));
const dependencies: Dependencies = {
  executeToolCall: (call, signal) => registry.execute(call, signal),
  decide: createContextDecision(registry.list(), async (context) => {
    console.log(`context fields: ${Object.keys(context).join(", ")}`);
    console.log(`messages: ${context.messages.map((message) => message.role).join(" -> ")}`);
    const last = context.messages.at(-1);
    if (last?.role === "user") {
      return { kind: "tool", call: { id: "read-1", name: "read_text",
        arguments: { path: mode === "invalid" ? 42 : "project-name.txt" } } };
    }
    if (last?.role === "tool") {
      const result = last.result;
      if (result.status === "error") return { kind: "fail", reason: result.message };
      if (result.toolName === "read_text" && typeof result.value === "string") {
        return { kind: "tool", call: { id: "length-1", name: "text_length", arguments: { text: result.value } } };
      }
      if (result.toolName === "text_length" && typeof result.value === "number") {
        return { kind: "finish", answer: String(result.value) };
      }
    }
    return { kind: "fail", reason: "Unexpected context" };
  }),
  // 最终验证仍使用完整 State，不能把模型输入当作唯一验证依据。
  validateFinish: (state, answer) => {
    const read = state.observations.find((o) => o.status === "ok" && o.toolName === "read_text");
    const length = state.observations.find((o) => o.status === "ok" && o.toolName === "text_length");
    return read?.status === "ok" && typeof read.value === "string"
      && length?.status === "ok" && length.value === read.value.length
      && answer === String(length.value);
  },
};
const result = await runAgentLoop({ goal: "Read the project name and count its UTF-16 code units" }, dependencies, 4);
console.log(`outcome: ${result.outcome.status}`);
console.log(`state decisions: ${result.state.decisions}`);
console.log(`state observations: ${result.state.observations.length}`);
console.log(`state messages: ${result.state.messages.map((message) => message.role).join(" -> ")}`);
if (result.outcome.status === "completed") console.log(`answer: ${result.outcome.answer}`);
if (result.outcome.status === "failed") console.log(`reason: ${result.outcome.reason}`);
